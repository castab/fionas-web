// Minimal stand-in for the fionas-commerce auth endpoints so admin e2e needs no real backend. Like the
// real API it demands a trusted Origin on login/logout and answers with a Secure, HttpOnly,
// host-only session cookie.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.env.COMMERCE_STUB_PORT ?? 4176);
const trustedOrigin = process.env.COMMERCE_STUB_TRUSTED_ORIGIN ?? 'http://127.0.0.1:4174';
// The real API's cookie name and format: http4k quotes the value (`__Host-fionas_session="token"`).
const cookieName = '__Host-fionas_session';

const user = {
	id: '00000000-0000-0000-0000-000000000001',
	username: 'brayan',
	displayName: 'Brayan',
	roles: ['commerce.administrator'],
	permissions: ['commerce.payment.record']
};
const password = 'e2e-password';
const sessions = new Set();

function send(res, status, body, headers = {}) {
	const json = body !== undefined;
	res.writeHead(status, { ...(json && { 'content-type': 'application/json' }), ...headers });
	res.end(json ? JSON.stringify(body) : undefined);
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

// Like http4k: a quoted or bare value is read as-is; a percent-encoded one (`%22token%22`) is not
// unwrapped, so it matches no session.
const sessionToken = (req) =>
	/(?:^|;\s*)__Host-fionas_session=("?)([^;"]*)\1(?:;|$)/.exec(req.headers.cookie ?? '')?.[2] ||
	null;

createServer(async (req, res) => {
	const { pathname } = new URL(req.url ?? '/', 'http://stub');
	const route = `${req.method} ${pathname}`;

	if (route === 'GET /ready') return send(res, 200, { ok: true });

	if (route === 'POST /auth/login' || route === 'POST /auth/logout') {
		if (req.headers.origin !== trustedOrigin) {
			return send(res, 403, {
				code: 'forbidden',
				message: 'The browser origin is not trusted'
			});
		}
	}

	if (route === 'POST /auth/login') {
		const body = await readJson(req);
		if (typeof body?.username !== 'string' || typeof body?.password !== 'string') {
			return send(res, 400, { code: 'malformed_request', message: 'Malformed request' });
		}
		// Test hooks: these usernames simulate rate limiting and an outage.
		if (body.username === 'ratelimited') {
			return send(
				res,
				429,
				{ code: 'rate_limited', message: 'Too many requests' },
				{ 'retry-after': '290' }
			);
		}
		if (body.username === 'outage') {
			return send(res, 500, {
				code: 'internal_failure',
				message: 'The request could not be completed'
			});
		}
		if (body.username !== user.username || body.password !== password) {
			return send(res, 401, { code: 'unauthenticated', message: 'Invalid credentials' });
		}
		const token = randomUUID();
		sessions.add(token);
		return send(res, 204, undefined, {
			'set-cookie': `${cookieName}="${token}"; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`
		});
	}

	if (route === 'GET /auth/me') {
		const token = sessionToken(req);
		if (!token || !sessions.has(token)) {
			return send(res, 401, { code: 'unauthenticated', message: 'Authentication is required' });
		}
		return send(res, 200, user);
	}

	if (route === 'POST /auth/logout') {
		const token = sessionToken(req);
		if (token) sessions.delete(token);
		return send(res, 204, undefined, {
			'set-cookie': `${cookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
		});
	}

	send(res, 404, { code: 'not_found', message: 'Not found' });
}).listen(port, '127.0.0.1', () => {
	console.log(`stub commerce (auth) listening on http://127.0.0.1:${port}`);
});
