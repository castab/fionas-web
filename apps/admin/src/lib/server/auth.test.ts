import type { Cookies } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import { applySetCookies, getCurrentUser, login, logout, parseSetCookie } from './auth.js';
import type { BackendConfig } from './backend.js';

const config = (fetch: BackendConfig['fetch']): BackendConfig => ({
	baseUrl: 'http://api.test',
	origin: 'https://admin.test',
	fetch
});

const session = 'fionas_session=tok; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax';

describe('login', () => {
	it('returns the session cookies on 204', async () => {
		const fetch = vi.fn(async () => {
			const headers = new Headers();
			headers.append('set-cookie', session);
			return new Response(null, { status: 204, headers });
		});
		const result = await login(config(fetch), { username: 'brayan', password: 'pw' });
		expect(result).toEqual({ ok: true, setCookies: [session] });

		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('http://api.test/auth/login');
		expect(JSON.parse(String(init.body))).toEqual({ username: 'brayan', password: 'pw' });
	});

	it.each([
		[401, 'unauthenticated'],
		[403, 'forbidden'],
		[400, 'malformed_request'],
		[500, 'internal_failure']
	])('reports a %i failure', async (status, code) => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const fetch = async () =>
			new Response(JSON.stringify({ code, message: 'm' }), {
				status,
				headers: { 'content-type': 'application/json' }
			});
		expect(await login(config(fetch), { username: 'a', password: 'b' })).toEqual({
			ok: false,
			status,
			code,
			retryAfter: null
		});
	});

	it('carries Retry-After on 429', async () => {
		const fetch = async () =>
			new Response(JSON.stringify({ code: 'rate_limited', message: 'm' }), {
				status: 429,
				headers: { 'content-type': 'application/json', 'retry-after': '120' }
			});
		expect(await login(config(fetch), { username: 'a', password: 'b' })).toMatchObject({
			ok: false,
			status: 429,
			retryAfter: 120
		});
	});

	it('reports an unreachable API as 503', async () => {
		const fetch = async () => {
			throw new Error('down');
		};
		expect(await login(config(fetch), { username: 'a', password: 'b' })).toMatchObject({
			ok: false,
			status: 503,
			code: 'unavailable'
		});
	});
});

describe('getCurrentUser', () => {
	const user = { id: '1', username: 'brayan', displayName: 'Brayan', roles: [], permissions: [] };

	it('preserves optional staff names from the current contract', async () => {
		const profile = { ...user, firstName: 'Brayan', lastName: 'Test' };
		expect(
			await getCurrentUser(
				config(async () => Response.json(profile)),
				'a=b'
			)
		).toEqual(profile);
	});

	it('forwards the cookie and returns the user', async () => {
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify(user), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
		);
		expect(await getCurrentUser(config(fetch), 'fionas_session=tok')).toEqual(user);
		const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(init.headers).toMatchObject({ cookie: 'fionas_session=tok' });
	});

	it('skips the API when there is no cookie', async () => {
		const fetch = vi.fn();
		expect(await getCurrentUser(config(fetch), null)).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});

	it('reads 401 and an unreachable API as signed out', async () => {
		const unauthenticated = async () =>
			new Response(JSON.stringify({ code: 'unauthenticated', message: 'm' }), { status: 401 });
		expect(await getCurrentUser(config(unauthenticated), 'a=b')).toBeNull();
		const down = async () => {
			throw new Error('down');
		};
		expect(await getCurrentUser(config(down), 'a=b')).toBeNull();
	});
});

describe('logout', () => {
	it('returns the clearing cookies', async () => {
		const clear = 'fionas_session=; Path=/; Max-Age=0; HttpOnly; Secure';
		const fetch = async () => {
			const headers = new Headers();
			headers.append('set-cookie', clear);
			return new Response(null, { status: 204, headers });
		};
		expect(await logout(config(fetch), 'fionas_session=tok')).toEqual([clear]);
	});

	it('returns nothing when the API fails', async () => {
		const fetch = async () => new Response(null, { status: 500 });
		expect(await logout(config(fetch), null)).toEqual([]);
	});
});

describe('parseSetCookie', () => {
	it('keeps the backend’s name, value and security attributes', () => {
		expect(parseSetCookie(session)).toEqual({
			name: 'fionas_session',
			value: 'tok',
			options: { path: '/', httpOnly: true, secure: true, maxAge: 3600, sameSite: 'lax' }
		});
	});

	it('forces the path to / and reads Expires', () => {
		const parsed = parseSetCookie('s=1; Path=/auth; Expires=Wed, 21 Oct 2026 07:28:00 GMT');
		expect(parsed?.options.path).toBe('/');
		expect(parsed?.options.expires).toEqual(new Date('Wed, 21 Oct 2026 07:28:00 GMT'));
		expect(parsed?.options.httpOnly).toBe(false);
	});

	it('keeps = inside values and ignores unknown attributes', () => {
		expect(parseSetCookie('s=a=b==; Priority=High; Partitioned')).toMatchObject({
			name: 's',
			value: 'a=b=='
		});
	});

	it('rejects malformed cookies', () => {
		expect(parseSetCookie('')).toBeNull();
		expect(parseSetCookie('=novalue')).toBeNull();
		expect(parseSetCookie('noequals; HttpOnly')).toBeNull();
	});
});

describe('applySetCookies', () => {
	it('re-issues each cookie on the admin host', () => {
		const set = vi.fn();
		applySetCookies({ set } as unknown as Cookies, [session, 'bad', 'b=2; Path=/']);
		expect(set).toHaveBeenCalledTimes(2);
		expect(set).toHaveBeenNthCalledWith(1, 'fionas_session', 'tok', {
			path: '/',
			httpOnly: true,
			secure: true,
			maxAge: 3600,
			sameSite: 'lax'
		});
		expect(set).toHaveBeenNthCalledWith(2, 'b', '2', { path: '/', httpOnly: false });
	});
});
