// Stand-in for fionas-commerce's passkey and account routes (the plan's route table; shapes in
// docs/admin-passkeys.md). Like the real API it checks the trusted Origin on the public routes,
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

export const accountById = (id) => [...accounts.values()].find((account) => account.id === id);

const PUBLIC_FIELDS = [
	'id',
	'credentialId',
	'name',
	'aaguid',
	'transports',
	'backupEligible',
	'backedUp',
	'createdAt',
	'lastUsedAt'
];
/** What commerce answers about a passkey: never its public key or counter. */
const publicPasskey = (passkey) =>
	Object.fromEntries(PUBLIC_FIELDS.map((field) => [field, passkey[field]]));

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

/** The ceremony, consumed; null when unknown, expired, already used or of another kind. */
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

const unauthenticated = { code: 'unauthenticated', message: 'Authentication failed' };

/**
 * Handles the passkey and account routes. `ctx` carries the shared stub pieces: the current
 * session (or null), its token, `createSession(account)` → token, `deleteSessions(predicate)`,
 * the trusted origins and `send`/`readJson`.
 */
export async function passkeyRoute(req, res, pathname, ctx) {
	const { send, readJson, session, trustedOrigins } = ctx;
	const route = `${req.method} ${pathname}`;
	const origin = req.headers.origin;
	const account = session?.account ? accountById(session.account) : null;
	const sessionCookie = (token) =>
		`__Host-fionas_session="${token}"; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`;

	if (pathname === '/__test/account') {
		if (!account) {
			send(res, 401);
			return true;
		}
		if (req.method === 'GET') {
			send(res, 200, { ...account, passkeys: account.passkeys.map(publicPasskey) });
			return true;
		}
		const body = (await readJson(req)) ?? {};
		if (body.sudoExpired) session.authenticatedAt = Date.now() - SUDO_MS - 60_000;
		if (body.forgetPasskeys) account.passkeys = [];
		send(res, 204);
		return true;
	}

	if (route === 'POST /auth/passkey/options' || route === 'POST /auth/passkey') {
		if (!trustedOrigins.has(origin)) {
			send(res, 403, { code: 'forbidden', message: 'The browser origin is not trusted' });
			return true;
		}
		const rpId = new URL(origin).hostname;
		if (route === 'POST /auth/passkey/options') {
			const { ceremonyId, challenge } = startCeremony('authentication', null, rpId);
			send(
				res,
				200,
				{
					ceremonyId,
					publicKey: {
						challenge,
						rpId,
						timeout: CEREMONY_MS,
						userVerification: 'required',
						allowCredentials: []
					}
				},
				noStore
			);
			return true;
		}
		const body = await readJson(req);
		const credential = body?.credential;
		const ceremony = takeCeremony(body?.ceremonyId, 'authentication');
		if (!ceremony || typeof credential?.id !== 'string' || !credential.response) {
			send(res, 401, unauthenticated);
			return true;
		}
		const owner = [...accounts.values()].find((a) =>
			a.passkeys.some((passkey) => passkey.credentialId === credential.id)
		);
		if (!owner) {
			send(res, 401, { code: 'passkey_unknown', message: 'Unknown passkey' });
			return true;
		}
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
		if (!signed || !handleMatches || !counterOk) {
			send(res, 401, unauthenticated);
			return true;
		}
		passkey.signCount = auth.signCount;
		passkey.lastUsedAt = new Date().toISOString();
		passkey.backedUp = auth.backedUp;
		// Re-authenticating as the same person swaps sessions instead of leaving the old one.
		if (session?.account === owner.id) ctx.deleteSessions((s) => s === session);
		const token = ctx.createSession(owner);
		send(res, 204, undefined, { 'set-cookie': sessionCookie(token) });
		return true;
	}

	const staffRoute =
		pathname === '/staff/account' ||
		pathname === '/staff/passkeys' ||
		pathname.startsWith('/staff/passkeys/') ||
		pathname === '/staff/credentials/password';
	if (!staffRoute) return false;
	if (!session) {
		send(res, 401, { code: 'unauthenticated', message: 'Authentication is required' });
		return true;
	}
	if (!account) {
		send(res, 403, { code: 'forbidden', message: 'Only passkey-… stub users have accounts' });
		return true;
	}
	if (req.method !== 'GET' && origin !== undefined && !trustedOrigins.has(origin)) {
		send(res, 403, { code: 'forbidden', message: 'The browser origin is not trusted' });
		return true;
	}
	const recent = Date.now() - session.authenticatedAt <= SUDO_MS;
	const reauth = () =>
		send(res, 403, {
			code: 'reauthentication_required',
			message: 'Sign in again to continue'
		});
	const rpId = origin ? new URL(origin).hostname : 'localhost';

	if (route === 'GET /staff/account') {
		send(
			res,
			200,
			{
				id: account.id,
				username: account.username,
				displayName: account.displayName,
				roles: ['commerce.administrator'],
				authenticatedAt: new Date(session.authenticatedAt).toISOString(),
				passkeyCount: account.passkeys.length
			},
			noStore
		);
		return true;
	}

	if (route === 'GET /staff/passkeys') {
		send(
			res,
			200,
			{ userHandle: account.userHandle, passkeys: account.passkeys.map(publicPasskey) },
			noStore
		);
		return true;
	}

	if (route === 'POST /staff/passkeys/registration/options') {
		if (!recent) {
			reauth();
			return true;
		}
		if (account.passkeys.length >= LIMIT) {
			send(res, 409, { code: 'passkey_limit_reached', message: 'Too many passkeys' });
			return true;
		}
		account.userHandle ??= randomBytes(64).toString('base64url');
		const { ceremonyId, challenge } = startCeremony('registration', account.id, rpId);
		send(
			res,
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
						id: p.credentialId,
						type: 'public-key',
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
		return true;
	}

	if (route === 'POST /staff/passkeys') {
		const body = await readJson(req);
		const credential = body?.credential;
		const ceremony = takeCeremony(body?.ceremonyId, 'registration');
		if (!ceremony || ceremony.userId !== account.id || !credential?.response) {
			send(res, 401, unauthenticated);
			return true;
		}
		const data = clientData(credential, 'webauthn.create', ceremony, origin);
		const auth = authenticatorData(credential.response.authenticatorData, ceremony.rpId);
		const name = body.name ?? null;
		if (
			!data ||
			!auth ||
			typeof credential.response.publicKey !== 'string' ||
			(name !== null && (typeof name !== 'string' || !name.length || name.length > 64))
		) {
			send(res, 422, { code: 'validation_failed', message: 'The passkey was rejected' });
			return true;
		}
		if (
			[...accounts.values()].some((a) => a.passkeys.some((p) => p.credentialId === credential.id))
		) {
			send(res, 409, { code: 'passkey_already_registered', message: 'Already registered' });
			return true;
		}
		const passkey = {
			id: randomUUID(),
			credentialId: credential.id,
			name,
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
		send(res, 201, publicPasskey(passkey), noStore);
		return true;
	}

	const one = /^\/staff\/passkeys\/([^/]+)$/.exec(pathname);
	if (one && (req.method === 'PATCH' || req.method === 'DELETE')) {
		const passkey = account.passkeys.find((p) => p.id === one[1]);
		if (!passkey) {
			send(res, 404, { code: 'not_found', message: 'No such passkey' });
			return true;
		}
		if (req.method === 'DELETE') {
			if (!recent) {
				reauth();
				return true;
			}
			account.passkeys = account.passkeys.filter((p) => p !== passkey);
			send(res, 204);
			return true;
		}
		const name = (await readJson(req))?.name;
		if (name !== null && (typeof name !== 'string' || !name.length || name.length > 64)) {
			send(res, 422, { code: 'validation_failed', message: 'Invalid name' });
			return true;
		}
		passkey.name = name;
		send(res, 200, publicPasskey(passkey), noStore);
		return true;
	}

	if (route === 'PUT /staff/credentials/password') {
		const body = await readJson(req);
		if (body?.currentPassword !== account.password) {
			send(res, 401, { code: 'invalid_credentials', message: 'Wrong password' });
			return true;
		}
		if (
			typeof body.newPassword !== 'string' ||
			body.newPassword.length < 12 ||
			body.newPassword === body.currentPassword
		) {
			send(res, 422, { code: 'validation_failed', message: 'Password policy' });
			return true;
		}
		account.password = body.newPassword;
		// Every other device is signed out; this one gets a fresh session.
		ctx.deleteSessions((s) => s.account === account.id);
		const token = ctx.createSession(account);
		send(res, 204, undefined, { 'set-cookie': sessionCookie(token) });
		return true;
	}

	send(res, 404, { code: 'not_found', message: 'Not found' });
	return true;
}
