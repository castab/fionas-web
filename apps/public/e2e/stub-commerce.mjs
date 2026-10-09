// Minimal stand-in for the fionas-commerce API so e2e needs no real backend. Serves fixtures
// aligned with the current contract, models SERVICE authentication and the POST /inquiries
// idempotency contract, and records what the app sent for assertions. A behavioral stub: tokens
// are opaque random strings, not JWTs, and nothing here is a real credential.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.env.COMMERCE_STUB_PORT ?? 4174);
// The test-only SERVICE:fionas-web the app must authenticate as (see playwright.config.ts).
const serviceId = process.env.COMMERCE_STUB_SERVICE_ID;
const credential = process.env.COMMERCE_STUB_SERVICE_CREDENTIAL;
if (!serviceId || !credential) {
	throw new Error('COMMERCE_STUB_SERVICE_ID and COMMERCE_STUB_SERVICE_CREDENTIAL are required');
}
const TOKEN_LIFETIME_SECONDS = 900;
/** Access tokens issued by POST /auth/service/token; the protected routes accept only these. */
const issued = new Set();

const unauthenticated = (res) =>
	send(res, 401, { code: 'unauthenticated', message: 'Authentication is required' });

const forbidden = (res) =>
	send(res, 403, {
		code: 'forbidden',
		message: 'The authenticated principal is not permitted to perform this request'
	});

/** Committed inquiries (request bodies), for assertions. */
const submissions = [];
/**
 * Every POST /inquiries the app made: for whom, under which Idempotency-Key, with which access
 * token, and whether the stub accepted that token.
 */
const attempts = [];
/** Idempotency-Key → { fingerprint, receipt }. */
const committed = new Map();

function send(res, status, body, headers = {}) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
	res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readJson(req) {
	return new Promise((resolve) => {
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			try {
				resolve(JSON.parse(raw));
			} catch {
				resolve(null);
			}
		});
	});
}

/** The issued access token a request carries, or null. */
function bearerOf(req) {
	const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
	return token && issued.has(token) ? token : null;
}

/*
 * Test hooks, chosen by the email's prefix (`seen`: earlier attempts for that email):
 * lost-      → commit, then drop the connection (the app must retry with the same key)
 * down-      → 503 for the first two attempts
 * reused-    → 409 IDEMPOTENCY_KEY_REUSED for the first key used
 * invalid-   → 422 with a stable violation code
 * expired-   → 401 for the first attempt, as if its access token had just expired
 * forbidden- → 403: the service lacks fionas.inquiries.create
 * error500-  → 500 for the first two attempts, nothing recorded
 * hidden500- → the first attempt is recorded but answers 500; the second answers 500 too
 */
function scenario(body, key) {
	const email = String(body?.email ?? '');
	const seen = attempts.filter((a) => a.email === email);
	const prefix = email.split('-')[0];
	switch (prefix) {
		case 'lost':
			return seen.length === 0 ? 'drop' : null;
		case 'down':
			return seen.length < 2 ? 'down' : null;
		case 'reused':
			return seen.length === 0 || seen[0].key === key ? 'reused' : null;
		case 'invalid':
			return 'invalid';
		case 'expired':
			return seen.length === 0 ? 'expired' : null;
		case 'forbidden':
			return 'forbidden';
		case 'error500':
			return seen.length < 2 ? 'error500' : null;
		case 'hidden500':
			return seen.length === 0 ? 'commit500' : seen.length === 1 ? 'error500' : null;
		default:
			return null;
	}
}

function commit(key, body) {
	const id = randomUUID();
	const receipt = { id, createdAt: new Date().toISOString() };
	committed.set(key, { fingerprint: JSON.stringify(body), receipt });
	submissions.push(body);
	return receipt;
}

createServer(async (req, res) => {
	const { pathname } = new URL(req.url ?? '/', 'http://stub');

	if (req.method === 'GET' && pathname === '/ready') return send(res, 200, { ok: true });

	if (req.method === 'POST' && pathname === '/auth/service/token') {
		const body = await readJson(req);
		if (body === null || typeof body.serviceId !== 'string' || typeof body.secret !== 'string') {
			return send(res, 400, { code: 'malformed_request', message: 'Malformed request' });
		}
		if (body.serviceId !== serviceId || body.secret !== credential) {
			return send(
				res,
				401,
				{ code: 'unauthenticated', message: 'Service authentication failed' },
				{ 'cache-control': 'no-store' }
			);
		}
		const accessToken = `e2e-access-token-${randomUUID()}`;
		issued.add(accessToken);
		return send(
			res,
			200,
			{
				accessToken,
				tokenType: 'Bearer',
				expiresAt: new Date(Date.now() + TOKEN_LIFETIME_SECONDS * 1000).toISOString(),
				expiresIn: TOKEN_LIFETIME_SECONDS
			},
			{ 'cache-control': 'no-store' }
		);
	}

	if (req.method === 'POST' && pathname === '/inquiries') {
		const body = await readJson(req);
		const key = req.headers['idempotency-key'];
		const token = bearerOf(req);
		const hook = scenario(body, key);
		const authorized = token !== null && hook !== 'expired';
		attempts.push({ email: body?.email ?? null, key: key ?? null, token, authorized });

		if (!authorized) return unauthenticated(res);
		if (hook === 'forbidden') return forbidden(res);
		if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) {
			return send(res, 400, { code: 'malformed_request', message: 'Malformed request: header' });
		}
		// As the real API (definition version 7): requestedService is required, there is no plain inquiry.
		if (
			!body?.name ||
			!body?.email ||
			!body?.zipCode ||
			!body?.eventDate ||
			!body?.eventType ||
			typeof body?.requestedService !== 'object' ||
			body.requestedService === null ||
			!Array.isArray(body.lines) ||
			!body.lines.length
		) {
			return send(res, 400, { code: 'malformed_request', message: 'Malformed request' });
		}
		const conflict = (code) =>
			send(res, 409, { code, message: `${code} (diagnostic)` }, { 'cache-control': 'no-store' });

		// A failure before the idempotency lookup: whatever an earlier attempt did stays unknown.
		const internal = () =>
			send(res, 500, { code: 'internal_failure', message: 'The request could not be completed' });
		if (hook === 'error500') return internal();

		// Idempotency recognizes the immutable priced command before creating anything new.
		const prior = committed.get(key);
		if (prior) {
			if (prior.fingerprint !== JSON.stringify(body)) return conflict('IDEMPOTENCY_KEY_REUSED');
			return send(res, 201, prior.receipt, { location: `/inquiries/${prior.receipt.id}` });
		}
		if (hook === 'reused') return conflict('IDEMPOTENCY_KEY_REUSED');
		if (hook === 'down') {
			return send(res, 503, { code: 'internal_failure', message: 'Unavailable (diagnostic)' });
		}
		if (hook === 'invalid') {
			return send(res, 422, {
				code: 'validation_failed',
				message: 'guestCount cannot be priced (diagnostic)',
				violations: [{ code: 'INVALID_GUEST_COUNT' }]
			});
		}

		const receipt = commit(key, body);
		// The commit happened, then the backend failed before answering.
		if (hook === 'commit500') return internal();
		// The commit happened; the response never arrives.
		if (hook === 'drop') return req.socket.destroy();
		return send(res, 201, receipt, { location: `/inquiries/${receipt.id}` });
	}
	// Test hooks: what the app has committed / attempted so far.
	if (req.method === 'GET' && pathname === '/__submissions') return send(res, 200, submissions);
	if (req.method === 'GET' && pathname === '/__attempts') return send(res, 200, attempts);

	send(res, 404, { code: 'not_found', message: 'Not found' });
}).listen(port, '127.0.0.1');
