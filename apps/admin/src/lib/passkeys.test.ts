import { describe, expect, it } from 'vitest';
import {
	NUDGE_DISMISS_KEY,
	NUDGE_DISMISS_MS,
	ceremonyErrorMessage,
	dismissNudge,
	normalizePasskeyName,
	nudgeDismissed,
	passkeyFailure,
	passwordChangeFailureMessage,
	passwordChangeProblem,
	readAccount,
	readPasskey,
	readPasskeyList
} from './passkeys.js';
import { passkeyProvider } from './passkey-providers.js';

const passkey = {
	id: '3f2a1c9e-7b4d-4e8a-9c1f-2d3e4f5a6b7c',
	credentialId: 'AbC-123_x',
	name: 'Work laptop',
	aaguid: 'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4',
	transports: ['internal', 'hybrid'],
	backupEligible: true,
	backedUp: true,
	createdAt: '2026-11-20T18:00:00Z',
	lastUsedAt: null
};

describe('passkey readers', () => {
	it('reads a passkey and nothing else', () => {
		expect(readPasskey({ ...passkey, publicKey: 'SECRET' })).toEqual(passkey);
		expect(readPasskey({ ...passkey, name: undefined, aaguid: undefined })).toMatchObject({
			name: null,
			aaguid: null
		});
	});

	it.each([
		['a non-uuid id', { id: 'nope' }],
		['a non-base64url credential id', { credentialId: 'a+b/c=' }],
		['an over-long name', { name: 'x'.repeat(65) }],
		['a missing flag', { backedUp: undefined }],
		['a bad instant', { createdAt: 'yesterday' }]
	])('rejects %s', (_, change) => {
		expect(readPasskey({ ...passkey, ...change })).toBeNull();
	});

	it('reads a list only when every passkey reads', () => {
		expect(readPasskeyList({ userHandle: 'aGFuZGxl', passkeys: [passkey] })).toEqual({
			userHandle: 'aGFuZGxl',
			passkeys: [passkey]
		});
		expect(readPasskeyList({ passkeys: [] })).toEqual({ userHandle: null, passkeys: [] });
		expect(readPasskeyList({ passkeys: [passkey, { id: 'bad' }] })).toBeNull();
		expect(readPasskeyList([passkey])).toBeNull();
	});

	it('reads the account summary', () => {
		const account = {
			id: 'u1',
			username: 'brayan',
			displayName: 'Brayan',
			roles: ['commerce.administrator'],
			authenticatedAt: '2026-11-25T18:00:00Z',
			passkeyCount: 2
		};
		expect(readAccount({ ...account, extra: true })).toEqual(account);
		expect(readAccount({ ...account, passkeyCount: -1 })).toBeNull();
		expect(readAccount({ ...account, authenticatedAt: null })).toBeNull();
	});
});

describe('normalizePasskeyName', () => {
	it('trims and collapses whitespace, and treats blank as no name', () => {
		expect(normalizePasskeyName('  Work   laptop ')).toBe('Work laptop');
		expect(normalizePasskeyName('   ')).toBeNull();
		expect(normalizePasskeyName(null)).toBeNull();
	});

	it('refuses names commerce would refuse', () => {
		expect(normalizePasskeyName('x'.repeat(65))).toBeUndefined();
		expect(normalizePasskeyName('tab\there')).toBe('tab here');
		expect(normalizePasskeyName('bell\u0007')).toBeUndefined();
		expect(normalizePasskeyName(42)).toBeUndefined();
	});
});

describe('passkeyFailure copy', () => {
	it('names an unknown passkey so the password manager can drop it', () => {
		expect(passkeyFailure(401, 'passkey_unknown', 'sign-in')).toEqual({
			status: 401,
			code: 'passkey_unknown',
			message: 'That passkey isn’t set up for this account anymore. Sign in with your password.'
		});
	});

	it('keeps every other sign-in failure uniform', () => {
		expect(passkeyFailure(401, 'unauthenticated', 'sign-in').message).toBe(
			'That passkey didn’t work. Try again or use your password.'
		);
		expect(passkeyFailure(400, 'malformed_request', 'sign-in').code).toBe('validation_failed');
	});

	it('reuses the sign-in rate limit copy', () => {
		expect(passkeyFailure(429, 'rate_limited', 'sign-in', 290).message).toBe(
			'Too many attempts — try again in 5 minutes.'
		);
	});

	it('maps management failures', () => {
		expect(passkeyFailure(403, 'reauthentication_required').code).toBe('reauthentication_required');
		expect(passkeyFailure(403, 'forbidden').code).toBe('unavailable');
		expect(passkeyFailure(409, 'passkey_limit_reached').message).toContain('up to 20 passkeys');
		expect(passkeyFailure(409, 'passkey_already_registered').code).toBe(
			'passkey_already_registered'
		);
		expect(passkeyFailure(404, 'not_found').code).toBe('not_found');
		expect(passkeyFailure(401, 'unauthenticated').message).toBe(
			'Your session has ended. Sign in again.'
		);
		expect(passkeyFailure(503, 'unavailable').message).toBe(
			'Passkeys are unavailable right now. Try again shortly.'
		);
	});

	it('never passes commerce text through', () => {
		const failure = passkeyFailure(500, 'PRIVATE stack trace');
		expect(failure.code).toBe('unavailable');
		expect(failure.message).not.toContain('PRIVATE');
	});
});

describe('ceremonyErrorMessage', () => {
	const error = (name: string, code?: string) =>
		Object.assign(new Error('browser text'), { name, ...(code && { code }) });

	it('stays silent when the person cancels or a newer request replaces this one', () => {
		expect(ceremonyErrorMessage(error('NotAllowedError'))).toBeNull();
		expect(ceremonyErrorMessage(error('AbortError'))).toBeNull();
		expect(ceremonyErrorMessage(error('Error', 'ERROR_CEREMONY_ABORTED'), 'create')).toBeNull();
	});

	it('explains an existing passkey on this device when creating one', () => {
		expect(ceremonyErrorMessage(error('InvalidStateError'), 'create')).toBe(
			'This device or password manager already has a passkey for your account.'
		);
	});

	it('falls back to our own copy', () => {
		expect(ceremonyErrorMessage(error('SecurityError'))).toBe(
			'Passkeys can’t be used on this address.'
		);
		expect(ceremonyErrorMessage(new Error('x'), 'create')).toBe(
			'Your browser couldn’t create a passkey. Try again.'
		);
	});
});

describe('password change', () => {
	const input = {
		currentPassword: 'old password',
		newPassword: 'a much longer one',
		confirmPassword: 'a much longer one'
	};

	it('accepts a valid change', () => {
		expect(passwordChangeProblem(input)).toBeNull();
	});

	it.each([
		[{ currentPassword: '' }, 'current'],
		[{ newPassword: 'short', confirmPassword: 'short' }, 'new'],
		[{ newPassword: 'old password', confirmPassword: 'old password' }, 'new'],
		[{ confirmPassword: 'something else' }, 'confirm']
	] as const)('flags %o on the %s field', (change, field) => {
		expect(passwordChangeProblem({ ...input, ...change })?.field).toBe(field);
	});

	it('maps commerce failures to our copy', () => {
		expect(passwordChangeFailureMessage(401, 'invalid_credentials')).toBe(
			'Your current password isn’t right. Try again.'
		);
		expect(passwordChangeFailureMessage(422, 'validation_failed')).toContain('at least 12');
		expect(passwordChangeFailureMessage(429, 'rate_limited', 60)).toBe(
			'Too many attempts — try again in 1 minute.'
		);
		expect(passwordChangeFailureMessage(503, 'unavailable')).toBe(
			'Your password couldn’t be changed right now. Try again shortly.'
		);
	});
});

describe('passkey nudge dismissal', () => {
	const store = () => {
		const values = new Map<string, string>();
		return {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => void values.set(key, value)
		};
	};

	it('remembers "Not now" for 30 days', () => {
		const storage = store();
		const now = Date.UTC(2026, 10, 25);
		expect(nudgeDismissed(storage, now)).toBe(false);
		dismissNudge(storage, now);
		expect(storage.getItem(NUDGE_DISMISS_KEY)).toBe(String(now + NUDGE_DISMISS_MS));
		expect(nudgeDismissed(storage, now + NUDGE_DISMISS_MS - 1)).toBe(true);
		expect(nudgeDismissed(storage, now + NUDGE_DISMISS_MS)).toBe(false);
	});

	it('copes without storage', () => {
		expect(nudgeDismissed(null)).toBe(false);
		expect(() => dismissNudge(null)).not.toThrow();
		const full = {
			getItem: () => 'garbage',
			setItem: () => {
				throw new Error('QuotaExceededError');
			}
		};
		expect(nudgeDismissed(full)).toBe(false);
		expect(() => dismissNudge(full)).not.toThrow();
	});
});

describe('passkeyProvider', () => {
	it('names known providers by AAGUID, case-insensitively', () => {
		expect(passkeyProvider('EA9B8D66-4D01-1D21-3CE4-B6B48CB575D4')).toEqual({
			name: 'Google Password Manager',
			kind: 'password-manager'
		});
		expect(passkeyProvider('fbfc3007-154e-4ecc-8c0b-6e020557d7bd').name).toBe('Apple Passwords');
		expect(passkeyProvider('08987058-cadc-4b81-b6e1-30de50dcbe96').kind).toBe('platform');
		expect(passkeyProvider('ee882879-721c-4913-9775-3dfcce97072a').kind).toBe('security-key');
	});

	it('reads an all-zero or unknown AAGUID as a plain passkey', () => {
		expect(passkeyProvider('00000000-0000-0000-0000-000000000000')).toEqual({
			name: 'Passkey',
			kind: 'unknown'
		});
		expect(passkeyProvider(null).name).toBe('Passkey');
	});
});
