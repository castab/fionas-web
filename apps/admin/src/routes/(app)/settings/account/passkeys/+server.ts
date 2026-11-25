import { normalizePasskeyName } from '$lib/passkeys.js';
import { backendConfig } from '$lib/server/config.js';
import {
	finishPasskeyRegistration,
	listPasskeys,
	parseRegistrationCredential,
	passkeyError,
	passkeyResponse,
	readJsonBody,
	takeCeremony
} from '$lib/server/passkeys.js';
import type { RequestHandler } from './$types';

/** The signed-in staff member's passkeys (never public keys) and their WebAuthn user handle. */
export const GET: RequestHandler = async ({ request, url }) =>
	passkeyResponse(await listPasskeys(backendConfig(url.origin), request.headers.get('cookie')));

/** Finishes creating a passkey with this browser's ceremony; only whitelisted fields go on. */
export const POST: RequestHandler = async ({ request, url, cookies }) => {
	const body = await readJsonBody(request);
	const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
	const credential = parseRegistrationCredential(record.credential);
	const name = normalizePasskeyName(record.name);
	const ceremonyId = takeCeremony(cookies);
	if (!credential || name === undefined)
		return passkeyResponse(passkeyError(400, 'validation_failed'));
	if (!ceremonyId) return passkeyResponse(passkeyError(422, 'validation_failed'));
	const result = await finishPasskeyRegistration(
		backendConfig(url.origin),
		request.headers.get('cookie'),
		ceremonyId,
		credential,
		name
	);
	return result.ok
		? Response.json(result.data, { status: 201, headers: { 'cache-control': 'no-store' } })
		: passkeyResponse(result);
};
