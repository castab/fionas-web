/**
 * Browser side of passkeys: WebAuthn ceremonies through `@simplewebauthn/browser`, and only the
 * same-origin endpoints in `PASSKEY_ROUTES` (never commerce). Everything is feature-detected: a
 * browser without WebAuthn simply never sees passkey UI. See docs/admin-passkeys.md.
 */
import {
	WebAuthnAbortService,
	browserSupportsWebAuthn,
	browserSupportsWebAuthnAutofill,
	getBrowserCapabilities,
	startAuthentication,
	startRegistration,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON
} from '@simplewebauthn/browser';
import {
	PASSKEY_ROUTES,
	UNAVAILABLE_COPY,
	ceremonyErrorMessage,
	passkeyRoute,
	readPasskey,
	readPasskeyList,
	type Passkey,
	type PasskeyFailure,
	type PasskeyFailureCode,
	type PasskeyList
} from './passkeys.js';

/** A failure with copy to show, or `failure: null` when the person cancelled (stay quiet). */
export type PasskeyOutcome<T> =
	{ ok: true; data: T } | { ok: false; failure: PasskeyFailure | null };

const unavailable: PasskeyFailure = { status: 503, code: 'unavailable', message: UNAVAILABLE_COPY };

async function call(
	path: string,
	method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
	body?: unknown
): Promise<{ ok: true; data: unknown } | { ok: false; failure: PasskeyFailure }> {
	let response: Response;
	try {
		response = await fetch(path, {
			method,
			headers: {
				accept: 'application/json',
				...(body !== undefined && { 'content-type': 'application/json' })
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			credentials: 'same-origin',
			cache: 'no-store'
		});
	} catch {
		return { ok: false, failure: unavailable };
	}
	const data = response.status === 204 ? null : await response.json().catch(() => undefined);
	if (response.ok) return { ok: true, data };
	const envelope = data as { code?: unknown; message?: unknown } | undefined;
	return {
		ok: false,
		failure:
			typeof envelope?.code === 'string' && typeof envelope.message === 'string'
				? {
						status: response.status,
						code: envelope.code as PasskeyFailureCode,
						message: envelope.message
					}
				: { ...unavailable, status: response.status }
	};
}

export const supportsPasskeys = (): boolean => browserSupportsWebAuthn();

/** Whether passkeys can appear in the username field's autofill (conditional mediation). */
export async function supportsAutofill(): Promise<boolean> {
	return browserSupportsWebAuthnAutofill().catch(() => false);
}

/** Whether this browser can create a passkey silently right after a password sign-in. */
export async function supportsAutomaticUpgrade(): Promise<boolean> {
	if (!browserSupportsWebAuthn()) return false;
	try {
		return (await getBrowserCapabilities()).conditionalCreate === 'supported';
	} catch {
		return false;
	}
}

/** Cancels a pending ceremony, such as the autofill request when leaving the sign-in page. */
export const cancelCeremony = (): void => WebAuthnAbortService.cancelCeremony();

type SignalFunctions = {
	signalUnknownCredential?: (options: { rpId: string; credentialId: string }) => Promise<void>;
	signalAllAcceptedCredentials?: (options: {
		rpId: string;
		userId: string;
		allAcceptedCredentialIds: string[];
	}) => Promise<void>;
};
const signals = (): SignalFunctions | null =>
	typeof PublicKeyCredential === 'undefined'
		? null
		: (PublicKeyCredential as unknown as SignalFunctions);

/** Tells the password manager to drop a passkey this site no longer accepts (best effort). */
export async function signalUnknownCredential(credentialId: string): Promise<void> {
	const signal = signals()?.signalUnknownCredential;
	if (typeof signal !== 'function') return;
	await signal
		.call(PublicKeyCredential, { rpId: location.hostname, credentialId })
		.catch(() => undefined);
}

/** Tells the password manager which of this account's passkeys still work (best effort). */
export async function signalAcceptedCredentials(list: PasskeyList): Promise<void> {
	const signal = signals()?.signalAllAcceptedCredentials;
	if (typeof signal !== 'function' || !list.userHandle) return;
	await signal
		.call(PublicKeyCredential, {
			rpId: list.rpId ?? location.hostname,
			userId: list.userHandle,
			allAcceptedCredentialIds: list.passkeys.map((passkey) => passkey.credentialId)
		})
		.catch(() => undefined);
}

/** Options requests run one at a time, so the newest ceremony cookie belongs to the newest request. */
let optionsQueue: Promise<unknown> = Promise.resolve();
function queuedOptions(path: string) {
	const next = optionsQueue.then(() => call(path, 'POST', {}));
	optionsQueue = next.catch(() => undefined);
	return next;
}

/**
 * Signs in with a passkey. `autofill` waits for the person to pick a passkey from the username
 * field's suggestions and stays silent about anything they didn't do (an options or browser
 * failure); otherwise the browser shows its passkey dialog. Starting either cancels any other
 * pending ceremony. Also used signed in, to confirm it's you.
 */
export async function signInWithPasskey({ autofill = false }: { autofill?: boolean } = {}): Promise<
	PasskeyOutcome<null>
> {
	const options = await queuedOptions(PASSKEY_ROUTES.signInOptions);
	// Passkeys switched off in this deployment always reach the page, which then hides them.
	if (!options.ok)
		return autofill && options.failure.code !== 'passkeys_disabled'
			? { ok: false, failure: null }
			: options;
	const optionsJSON = (options.data as { publicKey?: PublicKeyCredentialRequestOptionsJSON })
		?.publicKey;
	if (!optionsJSON) return { ok: false, failure: autofill ? null : unavailable };
	let credential;
	try {
		credential = await startAuthentication({ optionsJSON, useBrowserAutofill: autofill });
	} catch (error) {
		const message = autofill ? null : ceremonyErrorMessage(error, 'get');
		return { ok: false, failure: message ? { ...unavailable, message } : null };
	}
	const result = await call(PASSKEY_ROUTES.signIn, 'POST', { credential });
	if (!result.ok && result.failure.code === 'passkey_unknown')
		await signalUnknownCredential(credential.id);
	return result.ok ? { ok: true, data: null } : result;
}

/**
 * Creates a passkey for the signed-in staff member. `automatic` asks the password manager the
 * person just signed in with to create one silently (conditional create). A
 * `reauthentication_required` failure means the person must confirm it's them first.
 */
export async function createPasskey({ automatic = false }: { automatic?: boolean } = {}): Promise<
	PasskeyOutcome<Passkey>
> {
	const options = await queuedOptions(PASSKEY_ROUTES.registrationOptions);
	if (!options.ok) return options;
	const optionsJSON = (options.data as { publicKey?: PublicKeyCredentialCreationOptionsJSON })
		?.publicKey;
	if (!optionsJSON) return { ok: false, failure: unavailable };
	let credential;
	try {
		credential = await startRegistration({ optionsJSON, useAutoRegister: automatic });
	} catch (error) {
		const message = ceremonyErrorMessage(error, 'create');
		return { ok: false, failure: message ? { ...unavailable, message } : null };
	}
	const result = await call(PASSKEY_ROUTES.passkeys, 'POST', { credential });
	if (!result.ok) return result;
	const passkey = readPasskey(result.data);
	return passkey ? { ok: true, data: passkey } : { ok: false, failure: unavailable };
}

export async function readPasskeys(): Promise<PasskeyOutcome<PasskeyList>> {
	const result = await call(PASSKEY_ROUTES.passkeys, 'GET');
	if (!result.ok) return result;
	const list = readPasskeyList(result.data);
	return list ? { ok: true, data: list } : { ok: false, failure: unavailable };
}

export async function renamePasskey(id: string, name: string | null) {
	const result = await call(passkeyRoute(id), 'PATCH', { name });
	if (!result.ok) return result;
	const passkey = readPasskey(result.data);
	return passkey
		? ({ ok: true, data: passkey } as const)
		: ({ ok: false, failure: unavailable } as const);
}

/** Removes a passkey; answers the remaining ones. */
export async function removePasskey(id: string): Promise<PasskeyOutcome<PasskeyList>> {
	const result = await call(passkeyRoute(id), 'DELETE');
	if (!result.ok) return result;
	const list = readPasskeyList(result.data);
	return list ? { ok: true, data: list } : { ok: false, failure: unavailable };
}

/** "Confirm it's you" with the signed-in staff member's password. */
export async function reauthenticateWithPassword(password: string): Promise<PasskeyOutcome<null>> {
	const result = await call(PASSKEY_ROUTES.reauthenticate, 'POST', { password });
	return result.ok ? { ok: true, data: null } : result;
}
