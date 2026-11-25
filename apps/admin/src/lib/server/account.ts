import type { Cookies } from '@sveltejs/kit';
import { request, type BackendConfig } from './backend.js';
import { readAccount, type StaffAccount } from '$lib/passkeys.js';

/**
 * The signed-in staff member's own account (fionas-commerce `GET /staff/account` and
 * `PUT /staff/credentials/password`), acting with their own session cookie and the trusted Origin.
 * Passwords are never logged or echoed. See docs/admin-passkeys.md.
 */
export type AccountResult<T> =
	| { ok: true; data: T; setCookies: string[] }
	| { ok: false; status: number; code: string; retryAfter: number | null };

export async function readStaffAccount(
	config: BackendConfig,
	cookie: string | null
): Promise<AccountResult<StaffAccount>> {
	const result = await request(config, '/staff/account', { cookie });
	if (!result.ok)
		return {
			ok: false,
			status: result.error.status,
			code: result.error.code,
			retryAfter: result.retryAfter
		};
	const account = readAccount(result.data);
	return account
		? { ok: true, data: account, setCookies: [] }
		: { ok: false, status: 503, code: 'unavailable', retryAfter: null };
}

/**
 * `PUT /staff/credentials/password`. Commerce verifies the current password, applies its policy,
 * signs out every other session and answers 204 with a fresh session `Set-Cookie`.
 */
export async function changePassword(
	config: BackendConfig,
	cookie: string | null,
	passwords: { currentPassword: string; newPassword: string }
): Promise<AccountResult<null>> {
	const result = await request(config, '/staff/credentials/password', {
		method: 'PUT',
		json: { currentPassword: passwords.currentPassword, newPassword: passwords.newPassword },
		cookie
	});
	if (result.ok) return { ok: true, data: null, setCookies: result.setCookies };
	return {
		ok: false,
		status: result.error.status,
		code: result.error.code,
		retryAfter: result.retryAfter
	};
}

/**
 * Set by the password sign-in only: the next signed-in page checks whether to suggest a passkey,
 * then clears it. It carries no data beyond "a password was just used".
 */
export const NUDGE_COOKIE = '__Host-fionas_passkey_nudge';

export function flagPasskeyNudge(cookies: Cookies): void {
	cookies.set(NUDGE_COOKIE, '1', {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		maxAge: 120
	});
}

/** True once, right after a password sign-in. */
export function takePasskeyNudge(cookies: Cookies): boolean {
	if (cookies.get(NUDGE_COOKIE) === undefined) return false;
	cookies.delete(NUDGE_COOKIE, { path: '/', secure: true });
	return true;
}
