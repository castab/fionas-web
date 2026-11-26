import type { Cookies } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { BackendConfig } from './backend.js';
import {
	NUDGE_COOKIE,
	changePassword,
	flagPasskeyNudge,
	readStaffAccount,
	takePasskeyNudge
} from './account.js';

function backend(response: Response) {
	const fetch = vi.fn(async () => response);
	const config: BackendConfig = {
		baseUrl: 'http://api.test',
		origin: 'https://admin.test',
		fetch: fetch as unknown as typeof globalThis.fetch
	};
	return { config, fetch };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});

const account = {
	authenticatedAt: '2026-11-25T18:00:00Z',
	recentAuthenticationUntil: '2026-11-25T18:10:00Z',
	passkeysEnabled: true,
	passkeyCount: 0
};

describe('readStaffAccount', () => {
	it('reads the account summary with the session cookie', async () => {
		const { config, fetch } = backend(json(200, account));
		expect(await readStaffAccount(config, '__Host-fionas_session="s"')).toEqual({
			ok: true,
			data: account,
			setCookies: []
		});
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('http://api.test/staff/account');
		expect((init.headers as Record<string, string>).cookie).toBe('__Host-fionas_session="s"');
	});

	it('treats an unreadable answer as unavailable', async () => {
		// The profile lives in /auth/me, never here: an old-style profile body doesn't read.
		const { config } = backend(json(200, { id: 'u1', username: 'brayan', passkeyCount: 0 }));
		expect(await readStaffAccount(config, null)).toMatchObject({ ok: false, status: 503 });
	});
});

describe('changePassword', () => {
	it('sends both passwords with PUT and returns the fresh session cookie', async () => {
		const set = '__Host-fionas_session="fresh"; Path=/; HttpOnly; Secure';
		const headers = new Headers();
		headers.append('set-cookie', set);
		const { config, fetch } = backend(new Response(null, { status: 204, headers }));
		const result = await changePassword(config, 'c', {
			currentPassword: 'old',
			newPassword: 'a much longer one'
		});
		expect(result).toEqual({ ok: true, data: null, setCookies: [set] });
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('http://api.test/staff/credentials/password');
		expect(init.method).toBe('PUT');
		expect(JSON.parse(String(init.body))).toEqual({
			currentPassword: 'old',
			newPassword: 'a much longer one'
		});
	});

	it('reports a wrong current password by its code', async () => {
		const { config } = backend(json(403, { code: 'current_password_incorrect', message: 'm' }));
		expect(
			await changePassword(config, 'c', { currentPassword: 'a', newPassword: 'b' })
		).toMatchObject({ ok: false, status: 403, code: 'current_password_incorrect' });
	});

	it('reports the status, code and wait time of a failure', async () => {
		const { config } = backend(
			json(429, { code: 'rate_limited', message: 'm' }, { 'retry-after': '60' })
		);
		expect(await changePassword(config, 'c', { currentPassword: 'a', newPassword: 'b' })).toEqual({
			ok: false,
			status: 429,
			code: 'rate_limited',
			retryAfter: 60
		});
	});
});

describe('the passkey nudge flag', () => {
	it('is set after a password sign-in and taken exactly once', () => {
		const values = new Map<string, string>();
		const set = vi.fn((name: string, value: string) => void values.set(name, value));
		const cookies = {
			get: (name: string) => values.get(name),
			set,
			delete: (name: string) => void values.delete(name)
		} as unknown as Cookies;
		expect(takePasskeyNudge(cookies)).toBe(false);
		flagPasskeyNudge(cookies);
		expect(set).toHaveBeenCalledWith(
			NUDGE_COOKIE,
			'1',
			expect.objectContaining({ httpOnly: true, secure: true })
		);
		expect(takePasskeyNudge(cookies)).toBe(true);
		expect(takePasskeyNudge(cookies)).toBe(false);
	});
});
