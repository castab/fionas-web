import type { Cookies } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { BackendConfig } from './backend.js';
import {
	CEREMONY_COOKIE,
	cookieHeader,
	finishPasskeyRegistration,
	finishPasskeySignIn,
	listPasskeys,
	parseAuthenticationCredential,
	parseRegistrationCredential,
	passkeyResponse,
	readCreationOptions,
	readJsonBody,
	rememberCeremony,
	removePasskey,
	renamePasskey,
	sameStaffMember,
	startPasskeyRegistration,
	startPasskeySignIn,
	takeCeremony
} from './passkeys.js';

const ceremonyId = '9b2f3c4d-1e2f-4a5b-8c6d-7e8f9a0b1c2d';
const passkeyId = '3f2a1c9e-7b4d-4e8a-9c1f-2d3e4f5a6b7c';
const passkey = {
	id: passkeyId,
	credentialId: 'Y3JlZA',
	name: null,
	aaguid: null,
	transports: ['internal'],
	backupEligible: false,
	backedUp: false,
	createdAt: '2026-11-20T18:00:00Z',
	lastUsedAt: null
};

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function backend(...responses: Response[]) {
	const calls: Call[] = [];
	const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(url),
			method: init?.method ?? 'GET',
			headers: init?.headers as Record<string, string>,
			body: init?.body ? JSON.parse(String(init.body)) : undefined
		});
		return responses.shift() ?? new Response(null, { status: 500 });
	});
	const config: BackendConfig = {
		baseUrl: 'http://api.test',
		origin: 'https://admin.test',
		fetch: fetch as unknown as typeof globalThis.fetch
	};
	return { config, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});
const noContent = (setCookie?: string) => {
	const headers = new Headers();
	if (setCookie) headers.append('set-cookie', setCookie);
	return new Response(null, { status: 204, headers });
};

const requestOptions = {
	challenge: 'Y2hhbGxlbmdl',
	rpId: 'admin.test',
	timeout: 300000,
	userVerification: 'required',
	allowCredentials: [],
	extensions: { evil: true }
};
const creationOptions = {
	rp: { id: 'admin.test', name: "Fiona's Admin" },
	user: { id: 'aGFuZGxl', name: 'brayan', displayName: 'Brayan' },
	challenge: 'Y2hhbGxlbmdl',
	pubKeyCredParams: [
		{ type: 'public-key', alg: -8 },
		{ type: 'public-key', alg: -7 },
		{ type: 'public-key', alg: -257 }
	],
	timeout: 300000,
	excludeCredentials: [{ id: 'Y3JlZA', type: 'public-key', transports: ['internal'] }],
	authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
	attestation: 'direct',
	extensions: { credProps: true }
};

const assertion = {
	id: 'Y3JlZA',
	rawId: 'Y3JlZA',
	type: 'public-key',
	response: {
		clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0',
		authenticatorData: 'YXV0aA',
		signature: 'c2ln',
		userHandle: 'aGFuZGxl'
	},
	authenticatorAttachment: 'platform',
	clientExtensionResults: { anything: 'goes' }
};
const attestation = {
	id: 'Y3JlZA',
	rawId: 'Y3JlZA',
	type: 'public-key',
	response: {
		clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0',
		attestationObject: 'b2JqZWN0',
		transports: ['internal', 'hybrid'],
		publicKeyAlgorithm: -7,
		publicKey: 'cHVibGlj',
		authenticatorData: 'YXV0aA',
		extra: 'dropped'
	},
	clientExtensionResults: { credProps: { rk: true }, other: 1 }
};

describe('passkey sign-in', () => {
	it('starts a ceremony with the trusted Origin and projects the options', async () => {
		const { config, calls } = backend(json(200, { ceremonyId, publicKey: requestOptions }));
		const result = await startPasskeySignIn(config);
		expect(calls[0]).toMatchObject({
			url: 'http://api.test/auth/passkey/options',
			method: 'POST',
			body: {}
		});
		expect(calls[0].headers.origin).toBe('https://admin.test');
		expect(calls[0].headers.cookie).toBeUndefined();
		expect(result).toMatchObject({ ok: true, data: { ceremonyId } });
		if (!result.ok) throw new Error('expected success');
		expect(result.data.publicKey).toEqual({
			challenge: 'Y2hhbGxlbmdl',
			rpId: 'admin.test',
			timeout: 300000,
			userVerification: 'required',
			allowCredentials: []
		});
	});

	it('treats unreadable options as an outage', async () => {
		const { config } = backend(json(200, { ceremonyId: 'nope', publicKey: requestOptions }));
		expect(await startPasskeySignIn(config)).toMatchObject({ ok: false, code: 'unavailable' });
	});

	it('reports a rate limit with its wait time', async () => {
		const { config } = backend(
			json(429, { code: 'rate_limited', message: 'm' }, { 'retry-after': '120' })
		);
		expect(await startPasskeySignIn(config)).toMatchObject({
			ok: false,
			status: 429,
			code: 'rate_limited',
			message: 'Too many attempts — try again in 2 minutes.'
		});
	});

	it('finishes with the ceremony and the session cookie, returning the new cookie', async () => {
		const set = '__Host-fionas_session="new"; Path=/; HttpOnly; Secure; SameSite=Lax';
		const { config, calls } = backend(noContent(set));
		const credential = parseAuthenticationCredential(assertion)!;
		const result = await finishPasskeySignIn(
			config,
			'__Host-fionas_session="old"; __Host-fionas_webauthn=x',
			ceremonyId,
			credential
		);
		expect(result).toEqual({ ok: true, data: null, setCookies: [set] });
		expect(calls[0].url).toBe('http://api.test/auth/passkey');
		expect(calls[0].body).toEqual({ ceremonyId, credential });
		// The ceremony cookie is admin-local and never forwarded.
		expect(calls[0].headers.cookie).toBe('__Host-fionas_session="old"');
	});

	it('reads commerce’s 404 for an unregistered passkey as passkey_unknown', async () => {
		const unknown = backend(json(404, { code: 'not_found', message: 'm' }));
		const credential = parseAuthenticationCredential(assertion)!;
		expect(await finishPasskeySignIn(unknown.config, null, ceremonyId, credential)).toMatchObject({
			ok: false,
			code: 'passkey_unknown'
		});
		const other = backend(json(401, { code: 'unauthenticated', message: 'PRIVATE' }));
		const failure = await finishPasskeySignIn(other.config, null, ceremonyId, credential);
		expect(failure).toMatchObject({ ok: false, code: 'unauthenticated' });
		expect(JSON.stringify(failure)).not.toContain('PRIVATE');
	});

	it('reports passkeys switched off in this deployment', async () => {
		const { config } = backend(json(503, { code: 'passkeys_disabled', message: 'm' }));
		expect(await startPasskeySignIn(config)).toMatchObject({
			ok: false,
			status: 503,
			code: 'passkeys_disabled'
		});
	});
});

describe('credential whitelisting', () => {
	it('copies only the assertion fields commerce needs', () => {
		expect(parseAuthenticationCredential(assertion)).toEqual({
			id: 'Y3JlZA',
			rawId: 'Y3JlZA',
			type: 'public-key',
			response: {
				clientDataJSON: assertion.response.clientDataJSON,
				authenticatorData: 'YXV0aA',
				signature: 'c2ln',
				userHandle: 'aGFuZGxl'
			},
			authenticatorAttachment: 'platform',
			clientExtensionResults: {}
		});
	});

	it.each([
		['a mismatched rawId', { rawId: 'b3RoZXI' }],
		['another type', { type: 'password' }],
		['a non-base64url signature', { response: { ...assertion.response, signature: 'a+b' } }],
		[
			'an over-long clientDataJSON',
			{ response: { ...assertion.response, clientDataJSON: 'A'.repeat(4097) } }
		]
	])('refuses an assertion with %s', (_, change) => {
		expect(parseAuthenticationCredential({ ...assertion, ...change })).toBeNull();
	});

	it('copies only the attestation fields commerce needs', () => {
		expect(parseRegistrationCredential(attestation)).toEqual({
			id: 'Y3JlZA',
			rawId: 'Y3JlZA',
			type: 'public-key',
			response: {
				clientDataJSON: attestation.response.clientDataJSON,
				attestationObject: 'b2JqZWN0',
				transports: ['internal', 'hybrid'],
				publicKeyAlgorithm: -7,
				publicKey: 'cHVibGlj',
				authenticatorData: 'YXV0aA'
			},
			clientExtensionResults: { credProps: { rk: true } }
		});
		expect(parseRegistrationCredential({ ...attestation, response: {} })).toBeNull();
		expect(parseRegistrationCredential(null)).toBeNull();
	});
});

describe('readCreationOptions', () => {
	it('keeps the creation options and never asks for attestation', () => {
		expect(readCreationOptions(creationOptions)).toEqual({
			...creationOptions,
			attestation: 'none'
		});
	});

	it('refuses options without algorithms or a user', () => {
		expect(readCreationOptions({ ...creationOptions, pubKeyCredParams: [] })).toBeNull();
		expect(readCreationOptions({ ...creationOptions, user: undefined })).toBeNull();
	});
});

describe('the ceremony cookie', () => {
	function jar() {
		const values = new Map<string, string>();
		const set = vi.fn((name: string, value: string) => void values.set(name, value));
		const cookies = {
			get: (name: string) => values.get(name),
			set,
			delete: vi.fn((name: string) => void values.delete(name))
		} as unknown as Cookies;
		return { cookies, set, values };
	}

	it('is HttpOnly, Secure, SameSite=Strict and lives five minutes', () => {
		const { cookies, set } = jar();
		rememberCeremony(cookies, ceremonyId);
		expect(set).toHaveBeenCalledWith(CEREMONY_COOKIE, ceremonyId, {
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'strict',
			maxAge: 300
		});
	});

	it('is consumed once, and ignored when it isn’t a ceremony id', () => {
		const { cookies, values } = jar();
		rememberCeremony(cookies, ceremonyId);
		expect(takeCeremony(cookies)).toBe(ceremonyId);
		expect(takeCeremony(cookies)).toBeNull();
		values.set(CEREMONY_COOKIE, 'not-a-uuid');
		expect(takeCeremony(cookies)).toBeNull();
		expect(values.has(CEREMONY_COOKIE)).toBe(false);
	});
});

describe('re-authentication stays the same person', () => {
	const set = '__Host-fionas_session="fresh"; Path=/; Max-Age=3600; HttpOnly; Secure';

	it('builds the Cookie header a browser would send', () => {
		expect(cookieHeader([set])).toBe('__Host-fionas_session="fresh"');
		expect(cookieHeader(['__Host-fionas_session=; Max-Age=0'])).toBeNull();
	});

	it('accepts the same staff member', async () => {
		const { config, calls } = backend(json(200, { id: 'u1', username: 'brayan' }));
		expect(await sameStaffMember(config, [set], 'u1')).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0].headers.cookie).toBe('__Host-fionas_session="fresh"');
	});

	it('signs a different account’s new session out again', async () => {
		const { config, calls } = backend(json(200, { id: 'u2' }), noContent());
		expect(await sameStaffMember(config, [set], 'u1')).toBe(false);
		expect(calls[1]).toMatchObject({ url: 'http://api.test/auth/logout', method: 'POST' });
		expect(calls[1].headers.cookie).toBe('__Host-fionas_session="fresh"');
	});
});

describe('managing passkeys', () => {
	const cookie = '__Host-fionas_session="s"';

	it('lists passkeys with the session cookie', async () => {
		const { config, calls } = backend(json(200, { userHandle: 'aGFuZGxl', passkeys: [passkey] }));
		expect(await listPasskeys(config, cookie)).toMatchObject({
			ok: true,
			data: { userHandle: 'aGFuZGxl', passkeys: [passkey] }
		});
		expect(calls[0]).toMatchObject({ url: 'http://api.test/staff/passkeys', method: 'GET' });
		expect(calls[0].headers.cookie).toBe(cookie);
	});

	it('surfaces reauthentication_required when the sign-in is too old', async () => {
		const { config, calls } = backend(
			json(403, { code: 'reauthentication_required', message: 'm' })
		);
		expect(await startPasskeyRegistration(config, cookie)).toMatchObject({
			ok: false,
			status: 403,
			code: 'reauthentication_required'
		});
		expect(calls[0]).toMatchObject({
			url: 'http://api.test/staff/passkeys/registration/options',
			method: 'POST'
		});
	});

	it('finishes a registration with an optional name', async () => {
		const { config, calls } = backend(json(201, passkey));
		const credential = parseRegistrationCredential(attestation)!;
		expect(
			await finishPasskeyRegistration(config, cookie, ceremonyId, credential, null)
		).toMatchObject({ ok: true, data: passkey });
		expect(calls[0].body).toEqual({ ceremonyId, credential });
	});

	it('maps a registration conflict by where it happened', async () => {
		const conflict = () => json(409, { code: 'conflict', message: 'm' });
		const start = backend(conflict());
		expect(await startPasskeyRegistration(start.config, cookie)).toMatchObject({
			code: 'passkey_conflict',
			message: 'You can have up to 20 passkeys. Remove one to add another.'
		});
		const finish = backend(conflict());
		const credential = parseRegistrationCredential(attestation)!;
		expect(
			await finishPasskeyRegistration(finish.config, cookie, ceremonyId, credential, null)
		).toMatchObject({
			code: 'passkey_conflict',
			message: 'That passkey is already on your account, or you’ve reached 20 passkeys.'
		});
	});

	it('renames with a normalized name and refuses bad ids or names locally', async () => {
		const { config, calls } = backend(json(200, { ...passkey, name: 'Phone' }));
		expect(await renamePasskey(config, cookie, passkeyId, '  Phone ')).toMatchObject({
			ok: true,
			data: { name: 'Phone' }
		});
		expect(calls[0]).toMatchObject({
			url: `http://api.test/staff/passkeys/${passkeyId}`,
			method: 'PATCH',
			body: { name: 'Phone' }
		});
		expect(await renamePasskey(config, cookie, '../admin', 'x')).toMatchObject({
			code: 'not_found'
		});
		expect(await renamePasskey(config, cookie, passkeyId, 'x'.repeat(65))).toMatchObject({
			code: 'validation_failed'
		});
		expect(calls).toHaveLength(1);
	});

	it('clears a name by sending an empty string, since commerce requires the field', async () => {
		const { config, calls } = backend(json(200, passkey));
		await renamePasskey(config, cookie, passkeyId, '   ');
		await renamePasskey(config, cookie, passkeyId, null);
		expect(calls.map((call) => call.body)).toEqual([{ name: '' }, { name: '' }]);
	});

	it('removes a passkey and reads the remaining ones from the answer', async () => {
		const { config, calls } = backend(
			json(200, { rpId: 'admin.test', userHandle: 'aGFuZGxl', passkeys: [] })
		);
		expect(await removePasskey(config, cookie, passkeyId)).toMatchObject({
			ok: true,
			data: { rpId: 'admin.test', userHandle: 'aGFuZGxl', passkeys: [] }
		});
		expect(calls[0]).toMatchObject({
			url: `http://api.test/staff/passkeys/${passkeyId}`,
			method: 'DELETE'
		});
	});
});

describe('our JSON answers', () => {
	it('answer failures with our own envelope, never cached', async () => {
		const response = passkeyResponse({
			ok: false,
			status: 409,
			code: 'passkey_conflict',
			message: 'copy'
		});
		expect(response.status).toBe(409);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({ code: 'passkey_conflict', message: 'copy' });
		expect((await passkeyResponse({ ok: true, data: null, setCookies: [] })).status).toBe(204);
	});

	it('accept only application/json bodies', async () => {
		const post = (type: string, body: string) =>
			new Request('http://admin.test/x', {
				method: 'POST',
				headers: { 'content-type': type },
				body
			});
		expect(await readJsonBody(post('application/json', '{"a":1}'))).toEqual({ a: 1 });
		expect(await readJsonBody(post('text/plain', '{"a":1}'))).toBeNull();
		expect(await readJsonBody(post('application/json', 'nope'))).toBeNull();
	});
});
