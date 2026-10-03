import type { Cookies } from '@sveltejs/kit';
import { request, type BackendConfig } from './backend.js';

/** `GET /auth/me`: the signed-in staff member. */
export type StaffUser = {
	id: string;
	username: string;
	displayName: string;
	firstName?: string;
	lastName?: string;
	roles: string[];
	permissions: string[];
};

export type LoginResult =
	| { ok: true; setCookies: string[] }
	| { ok: false; status: number; code: string; retryAfter: number | null };

/** `POST /auth/login`. On success the backend answers 204 with the session `Set-Cookie`. */
export async function login(
	config: BackendConfig,
	credentials: { username: string; password: string }
): Promise<LoginResult> {
	const result = await request(config, '/auth/login', { method: 'POST', json: credentials });
	if (result.ok) return { ok: true, setCookies: result.setCookies };
	return {
		ok: false,
		status: result.error.status,
		code: result.error.code,
		retryAfter: result.retryAfter
	};
}

/** `GET /auth/me`. Any failure (no session, disabled user, API down) reads as "signed out". */
export async function getCurrentUser(
	config: BackendConfig,
	cookie: string | null
): Promise<StaffUser | null> {
	if (!cookie) return null;
	const result = await request<StaffUser>(config, '/auth/me', { cookie });
	return result.ok ? result.data : null;
}

/** `POST /auth/logout`. Returns the `Set-Cookie` list that clears the browser cookie. */
export async function logout(config: BackendConfig, cookie: string | null): Promise<string[]> {
	const result = await request(config, '/auth/logout', { method: 'POST', cookie });
	return result.ok ? result.setCookies : [];
}

type CookieOptions = NonNullable<Parameters<Cookies['set']>[2]>;
export type ParsedSetCookie = { name: string; value: string; options: CookieOptions };

/**
 * Parse one `Set-Cookie` header into SvelteKit cookie options. The API doesn't promise a cookie
 * name, so this passes through whatever it is given. `Path` is forced to `/` so the cookie covers the
 * whole admin site, and the backend's own HttpOnly/Secure/SameSite choices are kept.
 */
export function parseSetCookie(header: string): ParsedSetCookie | null {
	const [pair, ...attributes] = header.split(';').map((part) => part.trim());
	const eq = pair.indexOf('=');
	if (eq < 1) return null;

	const options: CookieOptions = { path: '/', httpOnly: false };
	for (const attribute of attributes) {
		const [rawKey, ...rest] = attribute.split('=');
		const key = rawKey.trim().toLowerCase();
		const value = rest.join('=').trim();
		if (key === 'httponly') options.httpOnly = true;
		else if (key === 'secure') options.secure = true;
		else if (key === 'max-age' && Number.isFinite(Number(value))) options.maxAge = Number(value);
		else if (key === 'expires' && !Number.isNaN(Date.parse(value))) {
			options.expires = new Date(value);
		} else if (key === 'samesite') {
			const sameSite = value.toLowerCase();
			if (sameSite === 'lax' || sameSite === 'strict' || sameSite === 'none') {
				options.sameSite = sameSite;
			}
		}
	}
	return { name: pair.slice(0, eq), value: pair.slice(eq + 1), options };
}

/** Re-issue the backend's cookies on the admin host (login sets them, logout clears them). */
export function applySetCookies(cookies: Cookies, setCookies: string[]): void {
	for (const header of setCookies) {
		const parsed = parseSetCookie(header);
		if (parsed) cookies.set(parsed.name, parsed.value, parsed.options);
	}
}
