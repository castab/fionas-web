import { describe, expect, it, vi } from 'vitest';
import { request, type BackendConfig } from './backend.js';

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
});
