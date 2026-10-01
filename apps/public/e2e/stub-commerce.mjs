// Minimal stand-in for the fionas-commerce API so e2e needs no real backend. Serves fixtures
// captured from the real service, keeps the POST /inquiries idempotency contract, and records what
// the app sent for assertions.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const port = Number(process.env.COMMERCE_STUB_PORT ?? 4174);
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

// Like the real API, the UI endpoints demand the trusted server-side Bearer key.
const uiKey = process.env.COMMERCE_STUB_KEY ?? 'e2e-ui-key';
const secured = new Set(['GET /inquiry-form', 'POST /estimate-preview', 'POST /inquiries']);

// Only stale-catalog recovery asks for an uncached form (Cache-Control: no-cache). It gets the
// "next" catalog: revision 16, where Horchata is temporarily UNAVAILABLE (still listed) and cookie
// dough was disabled (so absent, as the public form never lists disabled offerings). Every other
// read stays on revision 15 (gummy bears unavailable), so parallel tests are unaffected.
const currentForm = fixture('inquiry-form.json');
const nextForm = (() => {
	const form = JSON.parse(currentForm);
	form.catalogRevision = 16;
	for (const field of form.sections.flatMap((s) => s.fields)) {
		if (field.input.type === 'OFFERING_CHOICE') {
			field.input.options = field.input.options
				.filter((o) => o.key !== 'cookie-dough')
				.map((o) => (o.key === 'horchata' ? { ...o, availability: 'UNAVAILABLE' } : o));
		}
	}
	return JSON.stringify(form);
})();

/** Offering keys a customer may pick, per catalog revision. */
const selectable = Object.fromEntries(
	[currentForm, nextForm].map((raw) => {
		const form = JSON.parse(raw);
		const keys = form.sections
			.flatMap((s) => s.fields)
			.flatMap((f) => (f.input.type === 'OFFERING_CHOICE' ? f.input.options : []))
			.filter((o) => o.selectionState === 'ENABLED' && o.availability === 'AVAILABLE')
			.map((o) => o.key);
		return [form.catalogRevision, new Set(keys)];
	})
);

/** As the real API: a pick that is unavailable (or unknown) at its revision is a 422. */
function offeringViolation(pricing) {
	const allowed = selectable[pricing?.catalogRevision];
	if (!allowed) return null;
	const picks = (pricing.selections ?? []).flatMap((s) => s.offerings ?? []);
	return picks.some((key) => !allowed.has(key)) ? 'OFFERING_UNAVAILABLE' : null;
}

const unavailableOffering = (res) =>
	send(res, 422, {
		code: 'validation_failed',
		message: 'Offering is unavailable (diagnostic)',
		violations: [{ code: 'OFFERING_UNAVAILABLE' }]
	});

/** Committed inquiries (request bodies), for assertions. */
const submissions = [];
/** Every POST /inquiries the app made: who, under which key, whether it carried the UI key. */
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

/*
 * Test hooks, chosen by the email's prefix (`seen`: earlier attempts for that email):
 * stale-   → 409 CATALOG_REVISION_STALE until the reviewed revision-16 form is sent
 * lost-    → commit, then drop the connection (the app must retry with the same key)
 * down-    → 503 for the first two attempts
 * reused-  → 409 IDEMPOTENCY_KEY_REUSED for the first key used
 * invalid- → 422 with a stable violation code
 */
function scenario(body, key) {
	const email = String(body?.email ?? '');
	const seen = attempts.filter((a) => a.email === email);
	const prefix = email.split('-')[0];
	switch (prefix) {
		case 'stale':
			return (body.pricingInputs?.catalogRevision ?? 0) < 16 ? 'stale' : null;
		case 'lost':
			return seen.length === 0 ? 'drop' : null;
		case 'down':
			return seen.length < 2 ? 'down' : null;
		case 'reused':
			return seen.length === 0 || seen[0].key === key ? 'reused' : null;
		case 'invalid':
			return 'invalid';
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
	if (
		secured.has(`${req.method} ${pathname}`) &&
		req.headers.authorization !== `Bearer ${uiKey}` &&
		pathname !== '/inquiries'
	) {
		return send(res, 401, { code: 'unauthenticated', message: 'Authentication is required' });
	}
	if (req.method === 'GET' && pathname === '/inquiry-form') {
		const fresh = /no-cache/.test(req.headers['cache-control'] ?? '');
		return send(res, 200, fresh ? nextForm : currentForm, {
			'cache-control': 'private, max-age=60, must-revalidate'
		});
	}
	if (req.method === 'POST' && pathname === '/estimate-preview') {
		// Test hooks: these guest counts simulate an outage / a rejected selection.
		const body = await readJson(req);
		if (body?.guestCount === 503) {
			return send(res, 503, {
				code: 'internal_failure',
				message: 'The request could not be completed'
			});
		}
		if (body?.guestCount === 422) {
			return send(res, 422, { code: 'validation_failed', message: 'Cannot be estimated' });
		}
		if (offeringViolation(body)) return unavailableOffering(res);
		return send(res, 200, fixture('estimate-preview.json'));
	}
	if (req.method === 'POST' && pathname === '/inquiries') {
		const body = await readJson(req);
		const key = req.headers['idempotency-key'];
		const authorized = req.headers.authorization === `Bearer ${uiKey}`;
		const hook = scenario(body, key);
		attempts.push({ email: body?.email ?? null, key: key ?? null, authorized });

		if (!authorized) {
			return send(res, 401, { code: 'unauthenticated', message: 'Authentication is required' });
		}
		if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) {
			return send(res, 400, { code: 'malformed_request', message: 'Malformed request: header' });
		}
		// As the real API (definition version 7): pricingInputs is required, there is no plain inquiry.
		if (
			!body?.name ||
			!body?.email ||
			!body?.zipCode ||
			!body?.eventDate ||
			!body?.eventType ||
			typeof body?.pricingInputs !== 'object' ||
			body.pricingInputs === null
		) {
			return send(res, 400, { code: 'malformed_request', message: 'Malformed request' });
		}
		const conflict = (code) =>
			send(res, 409, { code, message: `${code} (diagnostic)` }, { 'cache-control': 'no-store' });

		// Replay detection comes before any catalog check, as in the real API.
		const prior = committed.get(key);
		if (prior) {
			if (prior.fingerprint !== JSON.stringify(body)) return conflict('IDEMPOTENCY_KEY_REUSED');
			return send(res, 201, prior.receipt, { location: `/inquiries/${prior.receipt.id}` });
		}
		if (hook === 'stale') return conflict('CATALOG_REVISION_STALE');
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

		if (offeringViolation(body.pricingInputs)) {
			return unavailableOffering(res);
		}

		const receipt = commit(key, body);
		// The commit happened; the response never arrives.
		if (hook === 'drop') return req.socket.destroy();
		return send(res, 201, receipt, { location: `/inquiries/${receipt.id}` });
	}
	// Test hooks: what the app has committed / attempted so far.
	if (req.method === 'GET' && pathname === '/__submissions') return send(res, 200, submissions);
	if (req.method === 'GET' && pathname === '/__attempts') return send(res, 200, attempts);

	send(res, 404, { code: 'not_found', message: 'Not found' });
}).listen(port, '127.0.0.1');
