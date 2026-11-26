import { backendConfig } from '$lib/server/config.js';
import {
	passkeyError,
	passkeyResponse,
	readJsonBody,
	removePasskey,
	renamePasskey
} from '$lib/server/passkeys.js';
import type { RequestHandler } from './$types';

/** Renames one of the staff member's own passkeys; anyone else's id is a 404 in commerce. */
export const PATCH: RequestHandler = async ({ request, url, params }) => {
	const body = await readJsonBody(request);
	if (!body || typeof body !== 'object' || !('name' in body))
		return passkeyResponse(passkeyError(400, 'validation_failed'));
	return passkeyResponse(
		await renamePasskey(
			backendConfig(url.origin),
			request.headers.get('cookie'),
			params.passkeyId,
			(body as { name: unknown }).name
		)
	);
};

/** Removes a passkey; commerce answers 403 `reauthentication_required` outside sudo. */
export const DELETE: RequestHandler = async ({ request, url, params }) =>
	passkeyResponse(
		await removePasskey(backendConfig(url.origin), request.headers.get('cookie'), params.passkeyId)
	);
