import { backendConfig } from '$lib/server/config.js';
import {
	passkeyError,
	passkeyResponse,
	readJsonBody,
	rememberCeremony,
	startPasskeySignIn
} from '$lib/server/passkeys.js';
import type { RequestHandler } from './$types';

/**
 * Starts a passkey sign-in (the login page's autofill and button, and the "Confirm it's you"
 * dialog). Public: hooks.server.ts lets signed-out visitors through. The browser gets only the
 * WebAuthn options; the ceremony id stays in the HttpOnly ceremony cookie.
 */
export const POST: RequestHandler = async ({ request, url, cookies }) => {
	if ((await readJsonBody(request)) === null)
		return passkeyResponse(passkeyError(400, 'validation_failed', 'sign-in'));
	const result = await startPasskeySignIn(backendConfig(url.origin));
	if (!result.ok) return passkeyResponse(result);
	rememberCeremony(cookies, result.data.ceremonyId);
	return passkeyResponse({ ...result, data: { publicKey: result.data.publicKey } });
};
