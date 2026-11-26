/**
 * Passkeys and Account settings: the shapes the admin reads from commerce, the same-origin routes
 * the browser calls, and the copy for every outcome. Client-safe (no server imports); the server
 * projects each commerce response through these readers before it reaches a browser. See
 * docs/admin-passkeys.md.
 */
import { loginFailureMessage } from './login.js';

/** Same-origin JSON endpoints (never commerce). */
export const PASSKEY_ROUTES = {
	signInOptions: '/login/passkey/options',
	signIn: '/login/passkey',
	passkeys: '/settings/account/passkeys',
	registrationOptions: '/settings/account/passkeys/options',
	reauthenticate: '/settings/account/reauthenticate'
} as const;
export const passkeyRoute = (id: string) => `${PASSKEY_ROUTES.passkeys}/${encodeURIComponent(id)}`;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** Commerce stores names of 1–64 characters. */
export const PASSKEY_NAME_MAX = 64;
/** Commerce's limit per staff member. */
export const PASSKEY_LIMIT = 20;
/** The password policy commerce applies (NIST style: length only). */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
/** Commerce reports a missing AAGUID as all zeros. */
const ZERO_AAGUID = '00000000-0000-0000-0000-000000000000';

export type Passkey = {
	id: string;
	credentialId: string;
	name: string | null;
	aaguid: string | null;
	transports: string[];
	backupEligible: boolean;
	backedUp: boolean;
	createdAt: string;
	lastUsedAt: string | null;
};
/** `GET /staff/passkeys` and the `DELETE` answer: the relying party, user handle and passkeys. */
export type PasskeyList = { rpId: string | null; userHandle: string | null; passkeys: Passkey[] };
/**
 * `GET /staff/account`: the session's sign-in state only. Who the person is comes from
 * `/auth/me` (`locals.user`).
 */
export type StaffAccount = {
	authenticatedAt: string;
	recentAuthenticationUntil: string;
	passkeysEnabled: boolean;
	passkeyCount: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max = 200): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= max;
const isInstant = (value: unknown): value is string =>
	isText(value, 64) && !Number.isNaN(Date.parse(value));
const isBase64url = (value: unknown, max = 2048): value is string =>
	typeof value === 'string' && value.length <= max && BASE64URL.test(value);
const absent = (value: unknown): value is null | undefined => value === null || value === undefined;

/**
 * Normalizes a passkey name: trimmed, inner whitespace collapsed, 1–64 characters, no control
 * characters. Blank means "no name" (null); undefined means invalid.
 */
export function normalizePasskeyName(value: unknown): string | null | undefined {
	if (absent(value)) return null;
	if (typeof value !== 'string') return undefined;
	const name = value.trim().replace(/\s+/g, ' ');
	if (!name) return null;
	if (name.length > PASSKEY_NAME_MAX || /\p{Cc}/u.test(name)) return undefined;
	return name;
}

export function readPasskey(value: unknown): Passkey | null {
	if (!isRecord(value)) return null;
	const { id, credentialId, name, aaguid, transports, backupEligible, backedUp } = value;
	if (
		!isText(id, 64) ||
		!UUID.test(id) ||
		!isBase64url(credentialId) ||
		!(absent(name) || isText(name, PASSKEY_NAME_MAX)) ||
		!(absent(aaguid) || (isText(aaguid, 64) && UUID.test(aaguid))) ||
		!(transports === undefined || Array.isArray(transports)) ||
		typeof backupEligible !== 'boolean' ||
		typeof backedUp !== 'boolean' ||
		!isInstant(value.createdAt) ||
		!(absent(value.lastUsedAt) || isInstant(value.lastUsedAt))
	)
		return null;
	return {
		id,
		credentialId,
		name: absent(name) ? null : name,
		aaguid: absent(aaguid) || aaguid === ZERO_AAGUID ? null : aaguid,
		transports: (transports ?? []).filter((t): t is string => isText(t, 32)),
		backupEligible,
		backedUp,
		createdAt: value.createdAt,
		lastUsedAt: absent(value.lastUsedAt) ? null : value.lastUsedAt
	};
}

export function readPasskeyList(value: unknown): PasskeyList | null {
	if (!isRecord(value) || !Array.isArray(value.passkeys)) return null;
	const passkeys = value.passkeys.map(readPasskey);
	if (passkeys.some((p) => p === null)) return null;
	const { rpId, userHandle } = value;
	if (!(absent(userHandle) || isBase64url(userHandle, 128)) || !(absent(rpId) || isText(rpId, 253)))
		return null;
	return {
		rpId: absent(rpId) ? null : rpId,
		userHandle: absent(userHandle) ? null : userHandle,
		passkeys: passkeys as Passkey[]
	};
}

export function readAccount(value: unknown): StaffAccount | null {
	if (!isRecord(value)) return null;
	const { authenticatedAt, recentAuthenticationUntil, passkeysEnabled, passkeyCount } = value;
	if (
		!isInstant(authenticatedAt) ||
		!isInstant(recentAuthenticationUntil) ||
		typeof passkeysEnabled !== 'boolean' ||
		typeof passkeyCount !== 'number' ||
		!Number.isSafeInteger(passkeyCount) ||
		passkeyCount < 0
	)
		return null;
	return { authenticatedAt, recentAuthenticationUntil, passkeysEnabled, passkeyCount };
}

/** The envelope our JSON endpoints answer failures with: our code and our copy only. */
export type PasskeyFailure = { status: number; code: PasskeyFailureCode; message: string };
export type PasskeyFailureCode =
	| 'unauthenticated'
	| 'passkey_unknown'
	| 'different_account'
	| 'reauthentication_required'
	| 'passkey_conflict'
	| 'passkeys_disabled'
	| 'invalid_credentials'
	| 'rate_limited'
	| 'not_found'
	| 'validation_failed'
	| 'unavailable';

/**
 * Where a failure happened, which picks the wording: passkey sign-in (and "Confirm it's you"),
 * starting or finishing a passkey registration, or any other passkey change.
 */
export type PasskeyContext = 'sign-in' | 'register-options' | 'register' | 'manage';

export const UNAVAILABLE_COPY = 'Passkeys are unavailable right now. Try again shortly.';
export const DISABLED_COPY = 'Passkeys aren’t available here. Sign in with your password.';

/**
 * Maps a commerce (or local) failure to our own code and copy; commerce's own message text is
 * never shown. Commerce's codes: 404 `not_found` at sign-in is a passkey it doesn't know (the
 * browser may drop it); every other sign-in failure is a uniform 401; registration conflicts are
 * 409 `conflict` (the limit when starting, the limit or a duplicate when finishing); 503
 * `passkeys_disabled` when passkeys are off in this deployment.
 */
export function passkeyFailure(
	status: number,
	code: string | null,
	context: PasskeyContext = 'manage',
	retryAfter: number | null = null
): PasskeyFailure {
	const failure = (c: PasskeyFailureCode, message: string): PasskeyFailure => ({
		status,
		code: c,
		message
	});
	if (status === 429) return failure('rate_limited', loginFailureMessage(429, retryAfter));
	if (status === 503 && code === 'passkeys_disabled')
		return failure('passkeys_disabled', DISABLED_COPY);
	if (code === 'different_account')
		return failure(
			'different_account',
			'That passkey belongs to a different account, so you were signed out. Sign in again.'
		);
	if (status === 404)
		return context === 'sign-in'
			? failure(
					'passkey_unknown',
					'That passkey isn’t set up for this account anymore. Sign in with your password.'
				)
			: failure('not_found', 'That passkey was already removed.');
	if (status === 403 && code === 'reauthentication_required')
		return failure('reauthentication_required', 'Confirm it’s you to continue.');
	if (status === 409)
		return failure(
			'passkey_conflict',
			context === 'register-options'
				? `You can have up to ${PASSKEY_LIMIT} passkeys. Remove one to add another.`
				: `That passkey is already on your account, or you’ve reached ${PASSKEY_LIMIT} passkeys.`
		);
	if (status === 401)
		return context === 'sign-in'
			? failure('unauthenticated', 'That passkey didn’t work. Try again or use your password.')
			: failure('unauthenticated', 'Your session has ended. Sign in again.');
	if (status === 400 || status === 422)
		return failure(
			'validation_failed',
			context === 'sign-in'
				? 'That passkey didn’t work. Try again or use your password.'
				: context === 'manage'
					? `Use a name of up to ${PASSKEY_NAME_MAX} characters, without special characters.`
					: 'That passkey couldn’t be saved. Try again.'
		);
	return failure('unavailable', UNAVAILABLE_COPY);
}

/** What the browser's own WebAuthn error means for the person, or null to stay silent. */
export function ceremonyErrorMessage(
	error: unknown,
	ceremony: 'create' | 'get' = 'get'
): string | null {
	const name = error instanceof Error ? error.name : '';
	const code = (error as { code?: unknown } | null)?.code;
	// The person cancelled, or we aborted the request ourselves (a newer ceremony replaced it).
	if (name === 'NotAllowedError' || name === 'AbortError' || code === 'ERROR_CEREMONY_ABORTED')
		return null;
	if (name === 'InvalidStateError' || code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED')
		return ceremony === 'create'
			? 'This device or password manager already has a passkey for your account.'
			: null;
	if (name === 'SecurityError') return 'Passkeys can’t be used on this address.';
	return ceremony === 'create'
		? 'Your browser couldn’t create a passkey. Try again.'
		: 'Your browser couldn’t use a passkey. Try again or use your password.';
}

/** The copy for a password change failure; never commerce's own text. */
export function passwordChangeFailureMessage(
	status: number,
	code: string | null,
	retryAfter: number | null = null
): string {
	if (status === 429) return loginFailureMessage(429, retryAfter);
	// Commerce answers a wrong current password with 403 `current_password_incorrect`; a 401 means
	// the session itself ended.
	if (code === 'current_password_incorrect') return 'Your current password isn’t right. Try again.';
	if (status === 401) return 'Your session has ended. Sign in again.';
	if (status === 400 || status === 422)
		return `Choose a new password of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters that’s different from your current one.`;
	return 'Your password couldn’t be changed right now. Try again shortly.';
}

/** Local checks before a password change reaches commerce. Returns copy, or null when valid. */
export function passwordChangeProblem(input: {
	currentPassword: string;
	newPassword: string;
	confirmPassword: string;
}): { field: 'current' | 'new' | 'confirm'; message: string } | null {
	if (!input.currentPassword) return { field: 'current', message: 'Enter your current password.' };
	if (input.newPassword.length < PASSWORD_MIN)
		return { field: 'new', message: `Use at least ${PASSWORD_MIN} characters.` };
	if (input.newPassword.length > PASSWORD_MAX)
		return { field: 'new', message: `Use at most ${PASSWORD_MAX} characters.` };
	if (input.newPassword === input.currentPassword)
		return { field: 'new', message: 'Choose a password that’s different from your current one.' };
	if (input.newPassword !== input.confirmPassword)
		return { field: 'confirm', message: 'The new passwords don’t match.' };
	return null;
}

/** "Not now" on the passkey prompt is remembered on this device for 30 days. */
export const NUDGE_DISMISS_KEY = 'fionas.passkeyNudge.dismissedUntil';
export const NUDGE_DISMISS_MS = 30 * 24 * 60 * 60 * 1000;

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

export function nudgeDismissed(storage: KeyValueStore | null, now = Date.now()): boolean {
	const until = Number(storage?.getItem(NUDGE_DISMISS_KEY));
	return Number.isFinite(until) && until > now;
}

export function dismissNudge(storage: KeyValueStore | null, now = Date.now()): void {
	try {
		storage?.setItem(NUDGE_DISMISS_KEY, String(now + NUDGE_DISMISS_MS));
	} catch {
		// Private mode or a full quota: the prompt may come back next sign-in, which is harmless.
	}
}
