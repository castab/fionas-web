// Minimal stand-in for the fionas-commerce auth endpoints so admin e2e needs no real backend. Like the
// real API it demands a trusted Origin on login/logout and answers with a Secure, HttpOnly,
// host-only session cookie.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { dashboardFixture } from './dashboard-fixture.mjs';
import { requestFixtures, proposalPair } from './request-fixture.mjs';

const port = Number(process.env.COMMERCE_STUB_PORT ?? 4176);
const trustedOrigin = process.env.COMMERCE_STUB_TRUSTED_ORIGIN ?? 'http://127.0.0.1:4174';
// The real API's cookie name and format: http4k quotes the value (`__Host-fionas_session="token"`).
const cookieName = '__Host-fionas_session';

const user = {
	id: '00000000-0000-0000-0000-000000000001',
	username: 'brayan',
	displayName: 'Brayan',
	roles: ['commerce.administrator'],
	permissions: [
		'fionas.inquiries.read',
		'commerce.financial-document.read',
		'commerce.financial-document.create',
		'commerce.deposit-requirement.manage'
	]
};
const password = 'e2e-password';
const sessions = new Map();

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
	const currentSession = sessions.get(sessionToken(req));
	if (currentSession && req.method === 'GET' && !pathname.startsWith('/__test/')) {
		currentSession.readPaths.push(pathname);
	}

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
		if (
			![
				user.username,
				'dashboard-forbidden',
				'dashboard-unavailable',
				'dashboard-empty',
				'dashboard-overlap',
				'request-read-only'
			].includes(body.username) ||
			body.password !== password
		) {
			return send(res, 401, { code: 'unauthenticated', message: 'Invalid credentials' });
		}
		const token = randomUUID();
		sessions.set(token, {
			mode: body.username,
			dashboardReads: 0,
			authReads: 0,
			readPaths: [],
			requestReads: 0,
			proposalAttempts: [],
			requests: requestFixtures(),
			permissions:
				body.username === 'request-read-only'
					? user.permissions.filter(
							(permission) => permission !== 'commerce.financial-document.create'
						)
					: [...user.permissions]
		});
		return send(res, 204, undefined, {
			'set-cookie': `${cookieName}="${token}"; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`
		});
	}

	if (route === 'GET /auth/me') {
		const token = sessionToken(req);
		if (!token || !sessions.has(token)) {
			return send(res, 401, { code: 'unauthenticated', message: 'Authentication is required' });
		}
		sessions.get(token).authReads++;
		return send(res, 200, { ...user, permissions: sessions.get(token).permissions });
	}

	if (route === 'GET /staff/dashboard' || pathname === '/__test/dashboard') {
		const session = sessions.get(sessionToken(req));
		if (!session)
			return send(res, 401, { code: 'unauthenticated', message: 'Authentication is required' });
		// Session-scoped test instrumentation avoids shared state races between parallel browsers.
		if (route === 'GET /__test/dashboard') return send(res, 200, session);
		if (route === 'POST /__test/dashboard') {
			const body = await readJson(req);
			session.mode = body?.mode ?? user.username;
			return send(res, 204);
		}
		if (route !== 'GET /staff/dashboard') return send(res, 404);
		session.dashboardReads++;
		if (session.mode === 'dashboard-forbidden')
			return send(res, 403, { code: 'forbidden', message: 'PRIVATE backend access diagnostic' });
		if (session.mode === 'dashboard-unavailable')
			return send(res, 500, {
				code: 'internal_failure',
				message: 'PRIVATE backend database diagnostic'
			});
		const projection = structuredClone(dashboardFixture);
		if (session.mode === 'dashboard-empty') {
			projection.summary = { new: 0, quoted: 0, booked: 0, needsClosing: 0 };
			for (const queue of Object.values(projection.workQueue)) queue.items = [];
		}
		if (session.mode === 'dashboard-overlap') {
			projection.workQueue.needsReply.items.push({
				...projection.workQueue.needsQuote.items[0],
				attentionSince: '2026-07-16T18:00:00Z',
				reasons: ['CUSTOMER_COMMUNICATION_UNACKNOWLEDGED']
			});
		}
		for (const queue of Object.values(projection.workQueue)) {
			for (const item of queue.items) {
				const request = session.requests[item.inquiryId];
				if (!request) continue;
				item.documentId = request.financial.id;
				item.stage = request.inquiry.lifecycle.stage;
				item.financialStage = request.financial.stage;
				item.version = request.financial.version;
			}
		}
		const issued = projection.workQueue.needsQuote.items.filter((item) => item.stage === 'QUOTED');
		projection.workQueue.needsQuote.items = projection.workQueue.needsQuote.items.filter(
			(item) => item.stage !== 'QUOTED'
		);
		projection.summary.new -= issued.length;
		projection.summary.quoted += issued.length;
		return send(res, 200, projection, { 'cache-control': 'no-store' });
	}

	if (pathname === '/__test/request') {
		if (!currentSession) return send(res, 401);
		if (req.method === 'GET') return send(res, 200, currentSession);
		if (req.method === 'POST') {
			const body = await readJson(req);
			currentSession.mode = body?.mode ?? user.username;
			if (body?.permissions) currentSession.permissions = body.permissions;
			if (body?.request) currentSession.requests[body.request.inquiry.id] = body.request;
			return send(res, 204);
		}
	}

	const requestMatch = /^\/staff\/requests\/([^/]+)$/.exec(pathname);
	if (req.method === 'GET' && requestMatch) {
		if (!currentSession) return send(res, 401);
		currentSession.requestReads++;
		const mode = currentSession.mode;
		const status =
			mode === 'request-forbidden'
				? 403
				: mode === 'request-not-found'
					? 404
					: mode === 'request-unavailable'
						? 500
						: null;
		if (status)
			return send(res, status, {
				code: 'failure',
				message: 'PRIVATE request database/access diagnostic'
			});
		const request = currentSession.requests[requestMatch[1]];
		if (!request)
			return send(res, 404, { code: 'not_found', message: 'PRIVATE inquiry identity diagnostic' });
		const projection = structuredClone(request);
		if (mode === 'request-missing-reconciliation') delete projection.financial.reconciliation;
		return send(res, 200, projection, { 'cache-control': 'no-store' });
	}

	const proposalMatch = /^\/staff\/requests\/([^/]+)\/proposals$/.exec(pathname);
	if (req.method === 'POST' && proposalMatch) {
		if (!currentSession) return send(res, 401);
		const body = await readJson(req);
		currentSession.proposalAttempts.push({ inquiryId: proposalMatch[1], body });
		if (
			req.headers.origin !== trustedOrigin ||
			!currentSession.permissions.includes('commerce.financial-document.create') ||
			!currentSession.permissions.includes('commerce.deposit-requirement.manage') ||
			currentSession.mode === 'proposal-forbidden'
		) {
			return send(res, 403, { code: 'forbidden', message: 'PRIVATE quote permission diagnostic' });
		}
		const request = currentSession.requests[proposalMatch[1]];
		if (!request || currentSession.mode === 'proposal-not-found')
			return send(res, 404, { code: 'not_found', message: 'PRIVATE quote identity diagnostic' });
		if (
			currentSession.mode === 'proposal-conflict' ||
			body?.expectedDocumentVersion !== request.financial.version ||
			request.financial.stage !== 'ESTIMATE' ||
			request.inquiry.lifecycle.stage !== 'REQUESTED' ||
			request.proposal != null ||
			request.depositRequirement.state !== 'NONE'
		) {
			return send(res, 409, {
				code: request.financial.stage !== 'ESTIMATE' ? 'illegal_transition' : 'conflict',
				message: 'PRIVATE stale ledger diagnostic'
			});
		}
		const terms = body?.terms;
		const positive = (value) =>
			typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) && /[1-9]/.test(value);
		const percentageValid = (value) => {
			if (!positive(value)) return false;
			const [whole, fraction = ''] = value.split('.');
			return BigInt(whole + fraction) <= 100n * 10n ** BigInt(fraction.length);
		};
		if (
			Object.keys(body ?? {}).length !== 2 ||
			!terms ||
			(terms.type === 'PERCENTAGE'
				? Object.keys(terms).length !== 2 || !percentageValid(terms.percentage)
				: terms.type !== 'FIXED' ||
					Object.keys(terms).length !== 3 ||
					!positive(terms.amount) ||
					terms.currency !== request.financial.currency) ||
			currentSession.mode === 'proposal-invalid'
		)
			return send(res, 422, { code: 'validation_failed', message: 'PRIVATE deposit diagnostic' });
		let pair;
		try {
			pair = proposalPair(
				request.inquiry.id,
				request.financial.id,
				request.financial.version + 1,
				request.financial.total,
				terms,
				request.financial.currency
			);
		} catch {
			return send(res, 422, {
				code: 'validation_failed',
				message: 'PRIVATE minor units diagnostic'
			});
		}
		if (currentSession.mode === 'proposal-unavailable')
			return send(res, 500, {
				code: 'internal_failure',
				message: 'PRIVATE quote transaction diagnostic'
			});
		request.financial.previousVersion = request.financial.version;
		request.financial.version++;
		request.financial.stage = 'QUOTE';
		request.financial.createdAt = '2026-07-16T19:01:00Z';
		request.inquiry.lifecycle.stage = 'QUOTED';
		Object.assign(request, pair);
		// Commit then fail: the UI must reload/review rather than immediately replay the mutation.
		if (currentSession.mode === 'proposal-ambiguous')
			return send(res, 500, {
				code: 'internal_failure',
				message: 'PRIVATE post-commit failure diagnostic'
			});
		return send(
			res,
			200,
			{ ...pair, financial: request.financial },
			{ 'cache-control': 'no-store' }
		);
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
	console.log(`stub commerce (auth + dashboard) listening on http://127.0.0.1:${port}`);
});
