import { applySetCookies, login } from '$lib/server/auth.js';
import { backendConfig } from '$lib/server/config.js';
import { passkeyError, passkeyResponse, readJsonBody } from '$lib/server/passkeys.js';
import type { RequestHandler } from './$types';

/**
 * "Confirm it's you" with a password. The username is the signed-in staff member's own, never the
 * browser's, so a re-authentication can only ever renew this person's session. Commerce revokes
 * the old session and issues a fresh one, which restarts the ten-minute window.
 */
export const POST: RequestHandler = async ({ request, url, cookies, locals }) => {
	// hooks.server.ts answers a JSON 401 before this runs when signed out.
	if (!locals.user) return passkeyResponse(passkeyError(401, 'unauthenticated'));
	const body = await readJsonBody(request);
	const password =
		body && typeof body === 'object' ? (body as { password?: unknown }).password : undefined;
	if (typeof password !== 'string' || !password || password.length > 1024)
		return passkeyResponse(passkeyError(422, 'validation_failed', 'sign-in'));
	const result = await login(
		backendConfig(url.origin),
		{ username: locals.user.username, password },
		request.headers.get('cookie')
	);
	if (!result.ok) {
		const failure = passkeyError(result.status, result.code, 'sign-in', result.retryAfter);
		return passkeyResponse(
			result.status === 401
				? {
						...failure,
						code: 'invalid_credentials',
						message: 'That password isn’t right. Try again.'
					}
				: failure
		);
	}
	applySetCookies(cookies, result.setCookies);
	return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
};
