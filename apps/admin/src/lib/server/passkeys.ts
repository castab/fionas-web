import type { Cookies } from '@sveltejs/kit';
import { request, type ApiResult, type BackendConfig } from './backend.js';
import { getCurrentUser, logout, parseSetCookie } from './auth.js';
import {
	BASE64URL,
	UUID,
	normalizePasskeyName,
	passkeyFailure,
	readPasskey,
	readPasskeyList,
	type Passkey,
	type PasskeyContext,
	type PasskeyFailure,
	type PasskeyList
} from '$lib/passkeys.js';

/**
 * Passkey sign-in and the staff member's own passkeys (fionas-commerce `/auth/passkey*` and
 * `/staff/passkeys*`). Every call goes through `request()` with the trusted Origin; the staff calls
 * carry the staff member's own session cookie. The ceremony id never reaches the browser: it lives
 * in the admin-local `__Host-fionas_webauthn` cookie, which `forwardedCookie` strips. Browser
 * credential JSON is whitelisted field by field before it is forwarded. See docs/admin-passkeys.md.
 */
export type PasskeyResult<T> =
	{ ok: true; data: T; setCookies: string[] } | ({ ok: false } & PasskeyFailure);

export const passkeyError = (
	status: number,
	code: string | null,
	context: PasskeyContext = 'manage',
	retryAfter: number | null = null
) => ({ ok: false as const, ...passkeyFailure(status, code, context, retryAfter) });

function fail<T>(result: ApiResult<unknown>, context: PasskeyContext): PasskeyResult<T> {
	if (result.ok) return passkeyError(503, 'unavailable', context);
	return passkeyError(result.error.status, result.error.code, context, result.retryAfter);
}

function project<T>(
	result: ApiResult<unknown>,
	read: (data: unknown) => T | null,
	context: PasskeyContext = 'manage'
): PasskeyResult<T> {
	if (!result.ok) return fail(result, context);
	const data = read(result.data);
	// A success we can't read is treated like an outage, never passed through.
	return data === null ? passkeyError(503, 'unavailable', context) : { ...result, data };
}

// --- The ceremony cookie -----------------------------------------------------------------------

export const CEREMONY_COOKIE = '__Host-fionas_webauthn';
/** A ceremony lives five minutes in commerce; the cookie never outlives it. */
const CEREMONY_MAX_AGE = 300;

export function rememberCeremony(cookies: Cookies, ceremonyId: string): void {
	cookies.set(CEREMONY_COOKIE, ceremonyId, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'strict',
		maxAge: CEREMONY_MAX_AGE
	});
}

/** The ceremony id this browser holds, consumed: one finish per ceremony. */
export function takeCeremony(cookies: Cookies): string | null {
	const ceremonyId = cookies.get(CEREMONY_COOKIE) ?? null;
	if (ceremonyId !== null) cookies.delete(CEREMONY_COOKIE, { path: '/', secure: true });
	return ceremonyId && UUID.test(ceremonyId) ? ceremonyId : null;
}

// --- Options (commerce → browser), projected to the WebAuthn JSON fields we use ------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const b64 = (value: unknown, max = 2048): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= max && BASE64URL.test(value);
const text = (value: unknown, max = 256): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= max;
const optional = <T>(value: T | undefined, key: string) =>
	value === undefined ? {} : { [key]: value };

type Descriptor = { id: string; type: 'public-key'; transports?: string[] };
function descriptors(value: unknown): Descriptor[] | null {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 64) return null;
	const out: Descriptor[] = [];
	for (const item of value) {
		if (!isRecord(item) || !b64(item.id) || item.type !== 'public-key') return null;
		const transports = Array.isArray(item.transports)
			? item.transports.filter((t): t is string => text(t, 32))
			: undefined;
		out.push({ id: item.id, type: 'public-key', ...optional(transports, 'transports') });
	}
	return out;
}
const timeout = (value: unknown) =>
	typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const hints = (value: unknown) =>
	Array.isArray(value) ? value.filter((h): h is string => text(h, 32)) : undefined;
const userVerification = (value: unknown) =>
	value === 'required' || value === 'preferred' || value === 'discouraged' ? value : undefined;

export type RequestOptionsJSON = {
	challenge: string;
	rpId?: string;
	timeout?: number;
	userVerification?: 'required' | 'preferred' | 'discouraged';
	allowCredentials: Descriptor[];
	hints?: string[];
};

export function readRequestOptions(value: unknown): RequestOptionsJSON | null {
	if (!isRecord(value) || !b64(value.challenge, 256)) return null;
	const allowCredentials = descriptors(value.allowCredentials);
	if (!allowCredentials || (value.rpId !== undefined && !text(value.rpId))) return null;
	return {
		challenge: value.challenge,
		...optional(value.rpId as string | undefined, 'rpId'),
		...optional(timeout(value.timeout), 'timeout'),
		...optional(userVerification(value.userVerification), 'userVerification'),
		allowCredentials,
		...optional(hints(value.hints), 'hints')
	};
}

export type CreationOptionsJSON = {
	rp: { id?: string; name: string };
	user: { id: string; name: string; displayName: string };
	challenge: string;
	pubKeyCredParams: { type: 'public-key'; alg: number }[];
	timeout?: number;
	excludeCredentials: Descriptor[];
	authenticatorSelection?: Record<string, string | boolean>;
	attestation?: 'none';
	extensions?: { credProps: true };
	hints?: string[];
};

export function readCreationOptions(value: unknown): CreationOptionsJSON | null {
	if (!isRecord(value) || !isRecord(value.rp) || !isRecord(value.user)) return null;
	const { rp, user } = value;
	const excludeCredentials = descriptors(value.excludeCredentials);
	const params = Array.isArray(value.pubKeyCredParams)
		? value.pubKeyCredParams.filter(
				(p): p is { type: 'public-key'; alg: number } =>
					isRecord(p) && p.type === 'public-key' && Number.isSafeInteger(p.alg)
			)
		: [];
	if (
		!text(rp.name) ||
		(rp.id !== undefined && !text(rp.id)) ||
		!b64(user.id, 128) ||
		!text(user.name) ||
		typeof user.displayName !== 'string' ||
		!b64(value.challenge, 256) ||
		!params.length ||
		!excludeCredentials
	)
		return null;
	const selection = isRecord(value.authenticatorSelection)
		? Object.fromEntries(
				Object.entries(value.authenticatorSelection).filter(
					([key, v]) =>
						[
							'residentKey',
							'requireResidentKey',
							'userVerification',
							'authenticatorAttachment'
						].includes(key) &&
						(typeof v === 'string' || typeof v === 'boolean')
				)
			)
		: undefined;
	return {
		rp: { name: rp.name, ...optional(rp.id as string | undefined, 'id') },
		user: { id: user.id, name: user.name, displayName: user.displayName },
		challenge: value.challenge,
		pubKeyCredParams: params.map(({ alg }) => ({ type: 'public-key' as const, alg })),
		...optional(timeout(value.timeout), 'timeout'),
		excludeCredentials,
		...optional(
			selection as Record<string, string | boolean> | undefined,
			'authenticatorSelection'
		),
		// We never ask for attestation, whatever the options say.
		attestation: 'none',
		extensions: { credProps: true },
		...optional(hints(value.hints), 'hints')
	};
}

type Ceremony<T> = { ceremonyId: string; publicKey: T };
const ceremony =
	<T>(read: (value: unknown) => T | null) =>
	(value: unknown): Ceremony<T> | null => {
		if (!isRecord(value) || typeof value.ceremonyId !== 'string' || !UUID.test(value.ceremonyId))
			return null;
		const publicKey = read(value.publicKey);
		return publicKey ? { ceremonyId: value.ceremonyId, publicKey } : null;
	};

// --- Credentials (browser → commerce), whitelisted --------------------------------------------

export type AuthenticationCredential = {
	id: string;
	rawId: string;
	type: 'public-key';
	response: {
		clientDataJSON: string;
		authenticatorData: string;
		signature: string;
		userHandle?: string;
	};
	authenticatorAttachment?: 'platform' | 'cross-platform';
	clientExtensionResults: Record<string, never>;
};

export type RegistrationCredential = {
	id: string;
	rawId: string;
	type: 'public-key';
	response: {
		clientDataJSON: string;
		attestationObject: string;
		transports?: string[];
		publicKeyAlgorithm?: number;
		publicKey?: string;
		authenticatorData?: string;
	};
	authenticatorAttachment?: 'platform' | 'cross-platform';
	clientExtensionResults: { credProps?: { rk: boolean } };
};

const attachment = (value: unknown) =>
	value === 'platform' || value === 'cross-platform' ? value : undefined;

function credentialBase(value: unknown) {
	if (!isRecord(value) || !isRecord(value.response)) return null;
	if (!b64(value.id, 1366) || value.rawId !== value.id || value.type !== 'public-key') return null;
	return {
		id: value.id,
		response: value.response,
		attachment: attachment(value.authenticatorAttachment)
	};
}

export function parseAuthenticationCredential(value: unknown): AuthenticationCredential | null {
	const base = credentialBase(value);
	if (!base) return null;
	const { clientDataJSON, authenticatorData, signature, userHandle } = base.response;
	if (
		!b64(clientDataJSON, 4096) ||
		!b64(authenticatorData, 4096) ||
		!b64(signature, 1024) ||
		!(userHandle === undefined || userHandle === null || b64(userHandle, 128))
	)
		return null;
	return {
		id: base.id,
		rawId: base.id,
		type: 'public-key',
		response: {
			clientDataJSON,
			authenticatorData,
			signature,
			...optional((userHandle as string | null | undefined) ?? undefined, 'userHandle')
		},
		...optional(base.attachment, 'authenticatorAttachment'),
		clientExtensionResults: {}
	};
}

export function parseRegistrationCredential(value: unknown): RegistrationCredential | null {
	const base = credentialBase(value);
	if (!base) return null;
	const { clientDataJSON, attestationObject, transports, publicKeyAlgorithm, publicKey } =
		base.response;
	const authenticatorData = base.response.authenticatorData;
	if (
		!b64(clientDataJSON, 4096) ||
		!b64(attestationObject, 16384) ||
		!(transports === undefined || Array.isArray(transports)) ||
		!(publicKeyAlgorithm === undefined || Number.isSafeInteger(publicKeyAlgorithm)) ||
		!(publicKey === undefined || b64(publicKey, 2048)) ||
		!(authenticatorData === undefined || b64(authenticatorData, 8192))
	)
		return null;
	const extensions = isRecord(value) ? value.clientExtensionResults : undefined;
	const credProps =
		isRecord(extensions) &&
		isRecord(extensions.credProps) &&
		typeof extensions.credProps.rk === 'boolean'
			? { rk: extensions.credProps.rk }
			: undefined;
	return {
		id: base.id,
		rawId: base.id,
		type: 'public-key',
		response: {
			clientDataJSON,
			attestationObject,
			...optional(
				(transports as unknown[] | undefined)?.filter((t): t is string => text(t, 32)).slice(0, 8),
				'transports'
			),
			...optional(publicKeyAlgorithm as number | undefined, 'publicKeyAlgorithm'),
			...optional(publicKey as string | undefined, 'publicKey'),
			...optional(authenticatorData as string | undefined, 'authenticatorData')
		},
		...optional(base.attachment, 'authenticatorAttachment'),
		clientExtensionResults: credProps ? { credProps } : {}
	};
}

// --- Sign-in -----------------------------------------------------------------------------------

/** `POST /auth/passkey/options`: a discoverable-credential request and its ceremony id. */
export async function startPasskeySignIn(
	config: BackendConfig
): Promise<PasskeyResult<Ceremony<RequestOptionsJSON>>> {
	return project(
		await request(config, '/auth/passkey/options', { method: 'POST', json: {} }),
		ceremony(readRequestOptions),
		'sign-in'
	);
}

/**
 * `POST /auth/passkey`. On success commerce answers 204 with the session `Set-Cookie`. When
 * `cookie` carries a valid session for the same staff member (a re-authentication), commerce
 * revokes that old session.
 */
export async function finishPasskeySignIn(
	config: BackendConfig,
	cookie: string | null,
	ceremonyId: string,
	credential: AuthenticationCredential
): Promise<PasskeyResult<null>> {
	const result = await request(config, '/auth/passkey', {
		method: 'POST',
		json: { ceremonyId, credential },
		cookie
	});
	return result.ok
		? { ok: true, data: null, setCookies: result.setCookies }
		: fail(result, 'sign-in');
}

/** The `Cookie` header a browser would send with these freshly issued cookies. */
export function cookieHeader(setCookies: string[]): string | null {
	const pairs = setCookies
		.map(parseSetCookie)
		.filter((parsed) => parsed !== null && parsed.options.maxAge !== 0 && parsed.value !== '')
		.map((parsed) => `${parsed!.name}=${parsed!.value}`);
	return pairs.length ? pairs.join('; ') : null;
}

/**
 * A re-authentication must stay the same person. When a passkey sign-in hands back a session for
 * a different account, that new session is signed out again and the caller keeps the old one.
 */
export async function sameStaffMember(
	config: BackendConfig,
	setCookies: string[],
	expectedUserId: string
): Promise<boolean> {
	const fresh = cookieHeader(setCookies);
	const user = await getCurrentUser(config, fresh);
	if (user?.id === expectedUserId) return true;
	if (fresh) await logout(config, fresh);
	return false;
}

// --- The staff member's own passkeys ------------------------------------------------------------

export async function listPasskeys(
	config: BackendConfig,
	cookie: string | null
): Promise<PasskeyResult<PasskeyList>> {
	return project(await request(config, '/staff/passkeys', { cookie }), readPasskeyList);
}

/** `POST /staff/passkeys/registration/options`; 403 `reauthentication_required` outside sudo. */
export async function startPasskeyRegistration(
	config: BackendConfig,
	cookie: string | null
): Promise<PasskeyResult<Ceremony<CreationOptionsJSON>>> {
	return project(
		await request(config, '/staff/passkeys/registration/options', {
			method: 'POST',
			json: {},
			cookie
		}),
		ceremony(readCreationOptions),
		'register-options'
	);
}

export async function finishPasskeyRegistration(
	config: BackendConfig,
	cookie: string | null,
	ceremonyId: string,
	credential: RegistrationCredential,
	name: string | null
): Promise<PasskeyResult<Passkey>> {
	return project(
		await request(config, '/staff/passkeys', {
			method: 'POST',
			json: { ceremonyId, credential, ...(name && { name }) },
			cookie
		}),
		readPasskey,
		'register'
	);
}

export async function renamePasskey(
	config: BackendConfig,
	cookie: string | null,
	passkeyId: string,
	name: unknown
): Promise<PasskeyResult<Passkey>> {
	const normalized = normalizePasskeyName(name);
	if (!UUID.test(passkeyId)) return passkeyError(404, 'not_found');
	if (normalized === undefined) return passkeyError(422, 'validation_failed');
	return project(
		await request(config, `/staff/passkeys/${passkeyId}`, {
			method: 'PATCH',
			// Commerce requires the field; a blank name clears it.
			json: { name: normalized ?? '' },
			cookie
		}),
		readPasskey
	);
}

/**
 * `DELETE /staff/passkeys/{id}`; 403 `reauthentication_required` outside sudo. Commerce answers
 * the remaining passkeys, which feed `signalAllAcceptedCredentials` without another read.
 */
export async function removePasskey(
	config: BackendConfig,
	cookie: string | null,
	passkeyId: string
): Promise<PasskeyResult<PasskeyList>> {
	if (!UUID.test(passkeyId)) return passkeyError(404, 'not_found');
	return project(
		await request(config, `/staff/passkeys/${passkeyId}`, { method: 'DELETE', cookie }),
		readPasskeyList
	);
}

const NO_STORE = { 'cache-control': 'no-store' };

/** The JSON answer for one of our endpoints: data or our own failure envelope, never cached. */
export function passkeyResponse<T>(result: PasskeyResult<T> | ({ ok: false } & PasskeyFailure)) {
	if (!result.ok) {
		const { status, code, message } = result;
		return Response.json({ code, message }, { status, headers: NO_STORE });
	}
	if (result.data === null) return new Response(null, { status: 204, headers: NO_STORE });
	return Response.json(result.data, { headers: NO_STORE });
}

/**
 * A JSON body, or null. Our endpoints accept only `application/json`, which a cross-site page can
 * send only after a CORS preflight that this app never answers.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
	if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
		return null;
	return request.json().catch(() => null);
}
