import { applySetCookies } from '$lib/server/auth.js';
import { backendConfig } from '$lib/server/config.js';
import {
	finishPasskeySignIn,
	parseAuthenticationCredential,
	passkeyError,
	passkeyResponse,
	readJsonBody,
	sameStaffMember,
	takeCeremony
} from '$lib/server/passkeys.js';
import type { RequestHandler } from './$types';

/**
 * Finishes a passkey sign-in with this browser's ceremony. Signed out, it signs in. Signed in, it
 * is a re-authentication ("Confirm it's you"): commerce revokes the session the request presents
 * and issues a new one. That new session must belong to the same staff member; another account's
 * is signed out again (409 `different_account`), so a re-authentication never switches people.
 */
export const POST: RequestHandler = async ({ request, url, cookies, locals }) => {
	const body = await readJsonBody(request);
	const credential = parseAuthenticationCredential(
		body && typeof body === 'object' ? (body as { credential?: unknown }).credential : null
	);
	const ceremonyId = takeCeremony(cookies);
	if (!credential) return passkeyResponse(passkeyError(400, 'validation_failed', 'sign-in'));
	// Without its ceremony (expired, or another tab replaced it) the attempt can't be verified.
	if (!ceremonyId) return passkeyResponse(passkeyError(401, 'unauthenticated', 'sign-in'));

	const config = backendConfig(url.origin);
	const result = await finishPasskeySignIn(
		config,
		request.headers.get('cookie'),
		ceremonyId,
		credential
	);
	if (!result.ok) return passkeyResponse(result);
	if (locals.user && !(await sameStaffMember(config, result.setCookies, locals.user.id)))
		return passkeyResponse(passkeyError(409, 'different_account', 'sign-in'));

	applySetCookies(cookies, result.setCookies);
	return passkeyResponse({ ...result, data: null });
};
