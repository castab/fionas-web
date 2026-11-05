// Deterministic stand-in for fionas-commerce's customer payment endpoints, so the public payment
// suite needs no Stripe, merchant secrets, NATS or Docker. Each test owns a scenario (its own
// publicId and bearer), so parallel browsers never share state. Like the real API: exactly one
// bearer header, the same 404 for unknown/rotated/revoked bearers, one active attempt per inquiry,
// and Idempotency-Key replays bound to their original body.
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';

const port = Number(process.env.PAYMENTS_STUB_PORT ?? 4031);
const scenarios = new Map();

function send(res, status, body, headers = {}) {
	res.writeHead(status, {
		...(body !== undefined && { 'content-type': 'application/json' }),
		'cache-control': 'no-store',
		...headers
	});
	res.end(body === undefined ? undefined : JSON.stringify(body));
}

function readBody(req) {
	return new Promise((resolve) => {
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => resolve(raw));
	});
}

const bearer = () => randomBytes(32).toString('base64url');
const one = (req, name) => {
	const values = req.headersDistinct[name] ?? [];
	return values.length === 1 ? values[0] : null;
};

function record(scenario, req, extra = {}) {
	scenario.calls.push({
		method: req.method,
		url: req.url,
		token: req.headersDistinct['x-fionas-payment-token'] ?? [],
		cookie: req.headers.cookie ?? null,
		authorization: req.headers.authorization ?? null,
		origin: req.headers.origin ?? null,
		...extra
	});
}

/** The summary commerce would show once an attempt is active: no new collection. */
function inProgress(summary) {
	return {
		...summary,
		canPay: false,
		unavailableReason: 'PAYMENT_IN_PROGRESS',
		paymentInProgress: true,
		checkoutRecoveryAvailable: true
	};
}

async function checkout(req, res, scenario) {
	const key = one(req, 'idempotency-key');
	const raw = await readBody(req);
	record(scenario, req, { key, body: raw });
	if (!key || one(req, 'content-type') !== 'application/json')
		return send(res, 400, { code: 'malformed_request', message: 'Malformed request' });
	const reply = scenario.replies.shift();
	if (reply === 'drop') return req.socket.destroy();
	if (reply?.delay) await new Promise((resolve) => setTimeout(resolve, reply.delay));
	if (reply?.status) return send(res, reply.status, reply.body);
	const previous = scenario.keys.get(key);
	if (previous) {
		if (previous.body !== raw)
			return send(res, 409, { code: 'conflict', message: 'CHECKOUT_KEY_REUSED' });
		return send(res, 200, previous.response);
	}
	if (scenario.summary.paymentInProgress && !reply?.replace)
		return send(res, 409, {
			code: 'checkout_in_progress',
			message: 'The existing Checkout is still open'
		});
	const attemptId = randomUUID();
	const session = `cs_test_${attemptId.replaceAll('-', '')}`;
	// The presentation is fixed when the attempt is created: a same-key replay above keeps it even
	// after the scenario switches modes, exactly like commerce's immutable uiMode.
	const response =
		scenario.uiMode === 'EMBEDDED'
			? {
					attemptId,
					uiMode: 'EMBEDDED',
					clientSecret: `${session}_secret_${randomBytes(12).toString('hex')}`,
					state: 'OPEN',
					outcome: 'PENDING'
				}
			: {
					attemptId,
					...(scenario.uiMode !== 'LEGACY' && { uiMode: 'HOSTED' }),
					url: `https://checkout.stripe.com/c/pay/${session}`,
					state: 'OPEN',
					outcome: 'PENDING'
				};
	scenario.secrets.push(response.clientSecret ?? response.url);
	scenario.keys.set(key, { body: raw, response });
	scenario.summary = inProgress(scenario.summary);
	send(res, 200, response);
}

createServer(async (req, res) => {
	const { pathname } = new URL(req.url ?? '/', 'http://stub');
	if (pathname === '/__test__/health') return send(res, 200, { ok: true });

	// Test control: create a scenario, update it, or read its call log.
	if (pathname === '/__test__/scenario' && req.method === 'POST') {
		const body = JSON.parse((await readBody(req)) || '{}');
		const publicId = randomUUID();
		const scenario = {
			token: bearer(),
			summary: body.summary,
			replies: body.replies ?? [],
			mode: body.mode ?? null,
			// How new attempts are presented: HOSTED (default), EMBEDDED, or LEGACY (no uiMode).
			uiMode: body.uiMode ?? 'HOSTED',
			revoked: false,
			keys: new Map(),
			secrets: [],
			calls: []
		};
		scenarios.set(publicId, scenario);
		return send(res, 200, { publicId, token: scenario.token });
	}
	const control = /^\/__test__\/scenario\/([^/]+)$/.exec(pathname);
	if (control) {
		const scenario = scenarios.get(control[1]);
		if (!scenario) return send(res, 404);
		if (req.method === 'GET')
			return send(res, 200, { calls: scenario.calls, secrets: scenario.secrets });
		const body = JSON.parse((await readBody(req)) || '{}');
		if (body.summary) scenario.summary = body.summary;
		if (body.replies) scenario.replies.push(...body.replies);
		if ('mode' in body) scenario.mode = body.mode;
		if (body.uiMode) scenario.uiMode = body.uiMode;
		if (body.revoked !== undefined) scenario.revoked = body.revoked;
		if (body.rotate) scenario.token = bearer();
		return send(res, 200, { token: scenario.token });
	}

	const match = /^\/public\/payments\/([^/]+)(\/checkout-sessions)?$/.exec(pathname);
	if (!match) return send(res, 404, { code: 'not_found', message: 'Not found' });
	const scenario = scenarios.get(match[1]);
	const token = one(req, 'x-fionas-payment-token');
	if (!token) return send(res, 400, { code: 'malformed_request', message: 'Malformed request' });
	if (!scenario || scenario.revoked || token !== scenario.token) {
		if (scenario) record(scenario, req);
		return send(res, 404, { code: 'not_found', message: 'Payment access was not found' });
	}
	if (scenario.mode === 'disabled')
		return send(res, 503, { code: 'stripe_disabled', message: 'Online payments are disabled' });
	if (scenario.mode === 'error')
		return send(res, 500, { code: 'internal_failure', message: 'PRIVATE database detail' });
	if (match[2] && req.method === 'POST') return checkout(req, res, scenario);
	if (!match[2] && req.method === 'GET') {
		record(scenario, req);
		return send(res, 200, scenario.summary);
	}
	send(res, 405, { code: 'malformed_request', message: 'Method not allowed' });
}).listen(port, '127.0.0.1');
