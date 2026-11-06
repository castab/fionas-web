import { describe, expect, it, vi } from 'vitest';
import { forwardedCookie, request, type BackendConfig } from './backend.js';

const respond = (init: { status: number; body?: unknown; headers?: HeadersInit }) =>
	new Response(init.body === undefined ? null : JSON.stringify(init.body), {
		status: init.status,
		headers: { 'content-type': 'application/json', ...init.headers }
	});

const config = (fetch: BackendConfig['fetch']): BackendConfig => ({
	baseUrl: 'http://api.test/',
	origin: 'https://admin.test',
	fetch
});

describe('request', () => {
	it('sends Origin, JSON body and forwarded cookie to the API base URL', async () => {
		const fetch = vi.fn(async () => respond({ status: 204 }));
		await request(config(fetch), '/auth/login', {
			method: 'POST',
			json: { username: 'a', password: 'b' },
			cookie: 'session=abc'
		});

		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('http://api.test/auth/login');
		expect(init.method).toBe('POST');
		expect(init.redirect).toBe('manual');
		expect(init.body).toBe(JSON.stringify({ username: 'a', password: 'b' }));
		expect(init.headers).toMatchObject({
			origin: 'https://admin.test',
			cookie: 'session=abc',
			'content-type': 'application/json'
		});
	});

	it('returns parsed data and Set-Cookie headers on success', async () => {
		const fetch = vi.fn(async () => {
			const headers = new Headers({ 'content-type': 'application/json' });
			headers.append('set-cookie', 'a=1; Path=/');
			headers.append('set-cookie', 'b=2; Path=/');
			return new Response(JSON.stringify({ id: 'u1' }), { status: 200, headers });
		});
		const result = await request<{ id: string }>(config(fetch), '/auth/me');
		expect(result).toEqual({
			status: 200,
			ok: true,
			data: { id: 'u1' },
			setCookies: ['a=1; Path=/', 'b=2; Path=/']
		});
	});

	it('treats 204 as null data', async () => {
		const result = await request(
			config(async () => respond({ status: 204 })),
			'/auth/logout'
		);
		expect(result).toMatchObject({ ok: true, data: null });
	});

	it('maps error bodies to an ApiError and reads Retry-After', async () => {
		const result = await request(
			config(async () =>
				respond({
					status: 429,
					body: { code: 'rate_limited', message: 'Too many requests' },
					headers: { 'retry-after': '290' }
				})
			),
			'/auth/login'
		);
		expect(result).toEqual({
			ok: false,
			retryAfter: 290,
			error: { status: 429, code: 'rate_limited', message: 'Too many requests', violations: [] }
		});
	});

	it('collects violation codes and falls back when the error body is not JSON', async () => {
		const withViolations = await request(
			config(async () =>
				respond({
					status: 422,
					body: { code: 'invalid', message: 'x', violations: [{ code: 'A' }, {}] }
				})
			),
			'/x'
		);
		expect(withViolations).toMatchObject({ ok: false, error: { violations: ['A'] } });

		const garbage = await request(
			config(async () => new Response('<html>', { status: 502 })),
			'/x'
		);
		expect(garbage).toMatchObject({
			ok: false,
			error: { status: 502, code: 'internal_failure' }
		});
	});

	it('reports an unreachable API as 503 unavailable', async () => {
		const result = await request(
			config(async () => {
				throw new TypeError('fetch failed');
			}),
			'/auth/me'
		);
		expect(result).toMatchObject({ ok: false, error: { status: 503, code: 'unavailable' } });
	});

	it('hints at the trusted-origin list on a 403 without logging secrets', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await request(
			config(async () => respond({ status: 403, body: { code: 'forbidden', message: 'no' } })),
			'/auth/login',
			{ method: 'POST', json: { password: 'hunter2' }, cookie: 'session=secret' }
		);
		expect(spy).toHaveBeenCalledOnce();
		const logged = String(spy.mock.calls[0]);
		expect(logged).toContain('https://admin.test');
		expect(logged).not.toContain('hunter2');
		expect(logged).not.toContain('secret');
		spy.mockRestore();
	});

	it('allows an Idempotency-Key only on the two named send routes, with their long timeout', async () => {
		const fetch = vi.fn(async () => respond({ status: 201, body: {} }));
		const timeout = vi.spyOn(AbortSignal, 'timeout');
		await request(config(fetch), '/staff/requests/abc/financial-emails', {
			method: 'POST',
			json: {},
			idempotencyKey: 'key_1-A',
			capability: 'financialEmailSend'
		});
		const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(init.headers).toMatchObject({ 'idempotency-key': 'key_1-A' });
		expect(timeout).toHaveBeenLastCalledWith(100000);
		await request(config(fetch), '/staff/requests/abc/financial-emails/preview', {
			method: 'POST',
			json: {},
			capability: 'financialEmailPreview'
		});
		expect(timeout).toHaveBeenLastCalledWith(30000);
		timeout.mockRestore();
		const refused = [
			// A key on the preview, or on any other route, or a send without one.
			{
				path: '/staff/requests/abc/financial-emails/preview',
				capability: 'financialEmailPreview',
				idempotencyKey: 'k'
			},
			{
				path: '/staff/requests/abc/payment-access',
				capability: 'financialEmailSend',
				idempotencyKey: 'k'
			},
			{ path: '/staff/requests/abc/financial-emails', idempotencyKey: 'k' },
			{ path: '/staff/requests/abc/financial-emails', capability: 'financialEmailSend' },
			{
				path: '/staff/requests/abc/financial-emails',
				capability: 'financialEmailSend',
				idempotencyKey: 'bad key'
			}
		] as const;
		for (const { path, ...options } of refused)
			await expect(request(config(fetch), path, { method: 'POST', ...options })).rejects.toThrow(
				TypeError
			);
		await expect(
			request(config(fetch), '/staff/requests/abc/financial-emails', {
				method: 'GET',
				capability: 'financialEmailSend',
				idempotencyKey: 'k'
			})
		).rejects.toThrow(TypeError);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('forwards the staff session but never admin-local recovery cookies', async () => {
		const fetch = vi.fn(async () => respond({ status: 204 }));
		await request(config(fetch), '/auth/me', {
			cookie:
				'fionas_fe0=sealed0; __Host-fionas_session="token"; fionas_fe1=sealed1; fionas_reply_intent=ptr'
		});
		const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect((init.headers as Record<string, string>).cookie).toBe('__Host-fionas_session="token"');
		expect(forwardedCookie('fionas_fe0=x')).toBeNull();
		expect(forwardedCookie(null)).toBeNull();
	});
});
