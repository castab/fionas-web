import { backendConfig } from '$lib/server/config.js';
import {
	passkeyError,
	passkeyResponse,
	readJsonBody,
	rememberCeremony,
	startPasskeyRegistration
} from '$lib/server/passkeys.js';
import type { RequestHandler } from './$types';

/**
 * Starts creating a passkey for the signed-in staff member. Commerce answers 403
 * `reauthentication_required` when the sign-in is older than ten minutes; the page then asks the
 * person to confirm it's them and retries.
 */
export const POST: RequestHandler = async ({ request, url, cookies }) => {
	if ((await readJsonBody(request)) === null)
		return passkeyResponse(passkeyError(400, 'validation_failed'));
	const result = await startPasskeyRegistration(
		backendConfig(url.origin),
		request.headers.get('cookie')
	);
	if (!result.ok) return passkeyResponse(result);
	rememberCeremony(cookies, result.data.ceremonyId);
	return passkeyResponse({ ...result, data: { publicKey: result.data.publicKey } });
};
