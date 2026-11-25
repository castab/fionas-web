// Stand-in for fionas-commerce's passkey and account routes (fionas-commerce
// `http/StaffAccountRoutes.kt`; summarized in docs/admin-passkeys.md). Like the real API it checks the trusted Origin on the public routes,
// binds each single-use, five-minute challenge to one ceremony kind (and, for registration, one
// staff member), checks clientDataJSON's type/challenge/origin, the rpIdHash, the UP and UV flags
// and the signature counter, and verifies assertion signatures with the public key captured at
// registration. Accounts are keyed by username, so parallel tests that each sign in as their own
// `passkey-…` user never share passkeys.
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';

const CEREMONY_MS = 5 * 60 * 1000;
const SUDO_MS = 10 * 60 * 1000;
const LIMIT = 20;
const noStore = { 'cache-control': 'no-store' };

/** username → { id, username, displayName, password, userHandle, passkeys } */
const accounts = new Map();
/** ceremonyId → { kind, challenge, userId, expiresAt, consumed } */
const ceremonies = new Map();

export const isPasskeyUsername = (username) =>
	typeof username === 'string' && /^passkey-[a-z0-9-]{1,60}$/.test(username);

export function accountFor(username, password) {
	if (!accounts.has(username))
		accounts.set(username, {
			id: randomUUID(),
			username,
			displayName: 'Passkey Tester',
			password,
			userHandle: null,
			passkeys: []
		});
	return accounts.get(username);
}

/**
 * The other stub users (brayan, dashboard-*, request-*) predate passkeys: they read an account as
 * if passkeys were switched off, so the specs written for them never see a passkey nudge.
 */
function fixtureAccount(mode) {
	const account = accountFor(`fixture:${mode}`, null);
	account.passkeysDisabled = true;
	return account;
}

export const accountById = (id) => [...accounts.values()].find((account) => account.id === id);

const ZERO_AAGUID = '00000000-0000-0000-0000-000000000000';
/**
 * What commerce answers about a passkey: never its public key or counter. Optional fields are
 * omitted rather than null, and a missing AAGUID is all zeros.
 */
const publicPasskey = (passkey) => ({
	id: passkey.id,
	...(passkey.name !== null && { name: passkey.name }),
	credentialId: passkey.credentialId,
	aaguid: passkey.aaguid ?? ZERO_AAGUID,
	backupEligible: passkey.backupEligible,
	backedUp: passkey.backedUp,
	transports: passkey.transports,
	createdAt: passkey.createdAt,
	...(passkey.lastUsedAt !== null && { lastUsedAt: passkey.lastUsedAt })
});
const passkeyList = (account, rpId) => ({
	rpId,
	...(account.userHandle && { userHandle: account.userHandle }),
	passkeys: account.passkeys.map(publicPasskey)
});

/** Like commerce's PasskeyName: trimmed, blank means none; too long or control characters fail. */
function passkeyName(text) {
	const trimmed = (text ?? '').trim();
	if (!trimmed) return { name: null };
	if (trimmed.length > 64 || /\p{Cc}/u.test(trimmed)) return null;
	return { name: trimmed };
}

function startCeremony(kind, userId, rpId) {
	for (const [id, ceremony] of ceremonies)
		if (ceremony.expiresAt < Date.now()) ceremonies.delete(id);
	const ceremonyId = randomUUID();
	const challenge = randomBytes(32).toString('base64url');
	ceremonies.set(ceremonyId, {
		kind,
		challenge,
		userId,
		rpId,
		expiresAt: Date.now() + CEREMONY_MS
	});
	return { ceremonyId, challenge };
}

/** The ceremony, spent whatever happens next; null when unknown, expired or of another kind. */
function takeCeremony(ceremonyId, kind) {
	const ceremony = ceremonies.get(ceremonyId);
	ceremonies.delete(ceremonyId);
	if (!ceremony || ceremony.kind !== kind || ceremony.expiresAt < Date.now()) return null;
	return ceremony;
}

function clientData(credential, type, ceremony, origin) {
	try {
		const data = JSON.parse(
			Buffer.from(credential.response.clientDataJSON, 'base64url').toString()
		);
		return data.type === type && data.challenge === ceremony.challenge && data.origin === origin
			? data
			: null;
	} catch {
		return null;
	}
}

function authenticatorData(base64url, rpId) {
	const bytes = Buffer.from(base64url ?? '', 'base64url');
	if (bytes.length < 37) return null;
	const rpIdHash = createHash('sha256').update(rpId).digest();
	const flags = bytes[32];
	// User present and user verified are both required.
	if (!bytes.subarray(0, 32).equals(rpIdHash) || (flags & 0x05) !== 0x05) return null;
	const parsed = {
		bytes,
		signCount: bytes.readUInt32BE(33),
		backupEligible: Boolean(flags & 0x08),
		backedUp: Boolean(flags & 0x10),
		aaguid: null
	};
	if (flags & 0x40 && bytes.length >= 55) {
		const hex = bytes.subarray(37, 53).toString('hex');
		parsed.aaguid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	}
	return parsed;
}

const error = (code, message) => ({ code, message });
const unauthenticated = error('unauthenticated', 'Passkey sign-in failed');
const disabled = error('passkeys_disabled', 'Passkeys are disabled');

/**
 * Handles the passkey and account routes. `ctx` carries the shared stub pieces: the current
 * session (or null), `createSession(account)` → token, `deleteSessions(predicate)`, the trusted
 * origins and `send`/`readJson`. A `passkey-…` user's session has its own account; any other
 * stub user (brayan, …) reads a fixture account with passkeys switched off.
 */
export async function passkeyRoute(req, res, pathname, ctx) {
	const { send, readJson, session, trustedOrigins } = ctx;
	const route = `${req.method} ${pathname}`;
	const origin = req.headers.origin;
	const account = session?.account
		? accountById(session.account)
		: session
			? fixtureAccount(session.mode)
			: null;
	const sessionCookie = (token) =>
		`__Host-fionas_session="${token}"; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`;
	const reply = (status, body, headers) => {
		send(res, status, body, headers);
		return true;
	};

	if (pathname === '/__test/account') {
		if (!session) return reply(401);
		if (req.method === 'GET')
			return reply(200, { ...account, passkeys: account.passkeys.map(publicPasskey) });
		const body = (await readJson(req)) ?? {};
		if (body.sudoExpired) session.authenticatedAt = Date.now() - SUDO_MS - 60_000;
		if (body.forgetPasskeys) account.passkeys = [];
		// Like a deployment without the FIONAS_WEBAUTHN_* settings, for this account only.
		if ('passkeysDisabled' in body) account.passkeysDisabled = Boolean(body.passkeysDisabled);
		return reply(204);
	}

	if (route === 'POST /auth/passkey/options' || route === 'POST /auth/passkey') {
		if (!trustedOrigins.has(origin))
			return reply(403, error('forbidden', 'The browser origin is not trusted'));
		const rpId = new URL(origin).hostname;
		if (route === 'POST /auth/passkey/options') {
			const { ceremonyId, challenge } = startCeremony('authentication', null, rpId);
			return reply(
				200,
				{
					ceremonyId,
					publicKey: {
						challenge,
						timeout: CEREMONY_MS,
						rpId,
						allowCredentials: [],
						userVerification: 'required'
					}
				},
				noStore
			);
		}
		const body = await readJson(req);
		const credential = body?.credential;
		if (typeof credential?.id !== 'string' || credential.rawId !== credential.id)
			return reply(400, error('malformed_request', 'Malformed request'));
		const ceremony = takeCeremony(body?.ceremonyId, 'authentication');
		if (!ceremony) return reply(401, unauthenticated);
		const owner = [...accounts.values()].find((a) =>
			a.passkeys.some((passkey) => passkey.credentialId === credential.id)
		);
		if (!owner) return reply(404, error('not_found', 'Passkey is not registered'));
		const passkey = owner.passkeys.find((p) => p.credentialId === credential.id);
		const data = clientData(credential, 'webauthn.get', ceremony, origin);
		const auth = authenticatorData(credential.response.authenticatorData, ceremony.rpId);
		const signed =
			data &&
			auth &&
			verify(
				passkey.algorithm === -8 ? null : 'sha256',
				Buffer.concat([
					auth.bytes,
					createHash('sha256')
						.update(Buffer.from(credential.response.clientDataJSON, 'base64url'))
						.digest()
				]),
				createPublicKey({
					key: Buffer.from(passkey.publicKey, 'base64url'),
					format: 'der',
					type: 'spki'
				}),
				Buffer.from(credential.response.signature ?? '', 'base64url')
			);
		const handleMatches =
			!credential.response.userHandle || credential.response.userHandle === owner.userHandle;
		const counterOk = auth && (auth.signCount === 0 || auth.signCount > passkey.signCount);
		if (!signed || !handleMatches || !counterOk) return reply(401, unauthenticated);
		passkey.signCount = auth.signCount;
		passkey.lastUsedAt = new Date().toISOString();
		passkey.backedUp = auth.backedUp;
		const token = ctx.createSession(owner);
		// Whatever session the request presented is revoked, whoever it belonged to.
		if (session) ctx.deleteSessions((s) => s === session);
		return reply(204, undefined, { 'set-cookie': sessionCookie(token) });
	}

	const staffRoute =
		pathname === '/staff/account' ||
		pathname === '/staff/passkeys' ||
		pathname.startsWith('/staff/passkeys/') ||
		pathname === '/staff/credentials/password';
	if (!staffRoute) return false;
	if (!session) return reply(401, error('unauthenticated', 'Authentication is required'));
	if (req.method !== 'GET' && origin !== undefined && !trustedOrigins.has(origin))
		return reply(403, error('forbidden', 'The browser origin is not trusted'));
	const recentUntil = session.authenticatedAt + SUDO_MS;
	const recent = Date.now() < recentUntil;
	const reauth = () => reply(403, error('reauthentication_required', 'Sign in again to continue'));
	const rpId = origin ? new URL(origin).hostname : 'localhost';
	const passkeysOff = Boolean(account.passkeysDisabled);

	if (route === 'GET /staff/account')
		return reply(
			200,
			{
				authenticatedAt: new Date(session.authenticatedAt).toISOString(),
				recentAuthenticationUntil: new Date(recentUntil).toISOString(),
				passkeysEnabled: !passkeysOff,
				passkeyCount: passkeysOff ? 0 : account.passkeys.length
			},
			noStore
		);

	if (route === 'PUT /staff/credentials/password') {
		const body = await readJson(req);
		if (typeof body?.currentPassword !== 'string' || typeof body?.newPassword !== 'string')
			return reply(400, error('malformed_request', 'Malformed request'));
		if (body.currentPassword !== account.password)
			return reply(403, error('current_password_incorrect', 'The current password is incorrect'));
		if (
			body.newPassword.length < 12 ||
			body.newPassword.length > 256 ||
			body.newPassword === body.currentPassword
		)
			return reply(422, error('validation_failed', 'Password must have at least 12 characters'));
		account.password = body.newPassword;
		// Every session of the caller ends; this browser gets a fresh one.
		ctx.deleteSessions((s) => s.account === account.id);
		const token = ctx.createSession(account);
		return reply(204, undefined, { 'set-cookie': sessionCookie(token) });
	}

	// Everything below is passkeys, which this deployment may have switched off.
	if (passkeysOff) return reply(503, disabled);

	if (route === 'GET /staff/passkeys') return reply(200, passkeyList(account, rpId), noStore);

	if (route === 'POST /staff/passkeys/registration/options') {
		if (!recent) return reauth();
		if (account.passkeys.length >= LIMIT)
			return reply(409, error('conflict', 'A staff account can have at most 20 passkeys'));
		account.userHandle ??= randomBytes(64).toString('base64url');
		const { ceremonyId, challenge } = startCeremony('registration', account.id, rpId);
		return reply(
			200,
			{
				ceremonyId,
				publicKey: {
					rp: { id: rpId, name: "Fiona's Admin" },
					user: {
						id: account.userHandle,
						name: account.username,
						displayName: account.displayName
					},
					challenge,
					pubKeyCredParams: [-8, -7, -257].map((alg) => ({ type: 'public-key', alg })),
					timeout: CEREMONY_MS,
					excludeCredentials: account.passkeys.map((p) => ({
						type: 'public-key',
						id: p.credentialId,
						transports: p.transports
					})),
					authenticatorSelection: {
						residentKey: 'required',
						requireResidentKey: true,
						userVerification: 'required'
					},
					attestation: 'none',
					extensions: { credProps: true }
				}
			},
			noStore
		);
	}

	if (route === 'POST /staff/passkeys') {
		const body = await readJson(req);
		const credential = body?.credential;
		if (typeof credential?.id !== 'string' || credential.rawId !== credential.id)
			return reply(400, error('malformed_request', 'Malformed request'));
		const notVerified = () =>
			reply(422, error('validation_failed', 'The passkey could not be verified'));
		const ceremony = takeCeremony(body?.ceremonyId, 'registration');
		if (!ceremony || ceremony.userId !== account.id) return notVerified();
		const data = clientData(credential, 'webauthn.create', ceremony, origin);
		const auth = authenticatorData(credential.response.authenticatorData, ceremony.rpId);
		const named = passkeyName(body.name);
		if (!named) return reply(422, error('validation_failed', 'Passkey name is invalid'));
		// The stub reads the SPKI key the browser reports; commerce parses the attestation object.
		if (
			!data ||
			!auth ||
			typeof credential.response.publicKey !== 'string' ||
			credential.clientExtensionResults?.credProps?.rk === false
		)
			return notVerified();
		if (
			account.passkeys.length >= LIMIT ||
			[...accounts.values()].some((a) => a.passkeys.some((p) => p.credentialId === credential.id))
		)
			return reply(409, error('conflict', 'This passkey is already registered'));
		const passkey = {
			id: randomUUID(),
			credentialId: credential.id,
			name: named.name,
			aaguid: auth.aaguid,
			transports: credential.response.transports ?? [],
			backupEligible: auth.backupEligible,
			backedUp: auth.backedUp,
			createdAt: new Date().toISOString(),
			lastUsedAt: null,
			publicKey: credential.response.publicKey,
			algorithm: credential.response.publicKeyAlgorithm,
			signCount: auth.signCount
		};
		account.passkeys.push(passkey);
		return reply(201, publicPasskey(passkey), noStore);
	}

	const one = /^\/staff\/passkeys\/([^/]+)$/.exec(pathname);
	if (one && (req.method === 'PATCH' || req.method === 'DELETE')) {
		if (req.method === 'DELETE' && !recent) return reauth();
		const passkey = account.passkeys.find((p) => p.id === one[1]);
		if (!passkey) return reply(404, error('not_found', 'Passkey was not found'));
		if (req.method === 'DELETE') {
			account.passkeys = account.passkeys.filter((p) => p !== passkey);
			return reply(200, passkeyList(account, rpId), noStore);
		}
		const body = await readJson(req);
		// The field is required: a blank name clears it.
		if (typeof body?.name !== 'string')
			return reply(400, error('malformed_request', 'Malformed request'));
		const named = passkeyName(body.name);
		if (!named) return reply(422, error('validation_failed', 'Passkey name is invalid'));
		passkey.name = named.name;
		return reply(200, publicPasskey(passkey), noStore);
	}

	return reply(404, error('not_found', 'Not found'));
}
