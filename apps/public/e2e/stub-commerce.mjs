// Minimal stand-in for the fionas-commerce API so e2e needs no real backend. Serves fixtures
// captured from the real service and records submitted inquiries for assertions.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const port = Number(process.env.COMMERCE_STUB_PORT ?? 4174);
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

// Like the real API, the UI endpoints demand the trusted server-side Bearer key.
const uiKey = process.env.COMMERCE_STUB_KEY ?? 'e2e-ui-key';
const secured = new Set(['GET /inquiry-form', 'POST /estimate-preview', 'POST /inquiries']);

const submissions = [];

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

createServer(async (req, res) => {
	const { pathname } = new URL(req.url ?? '/', 'http://stub');

	if (req.method === 'GET' && pathname === '/ready') return send(res, 200, { ok: true });
	if (secured.has(`${req.method} ${pathname}`) && req.headers.authorization !== `Bearer ${uiKey}`) {
		return send(res, 401, { code: 'unauthenticated', message: 'Authentication is required' });
	}
	if (req.method === 'GET' && pathname === '/inquiry-form') {
		return send(res, 200, fixture('inquiry-form.json'));
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
		return send(res, 200, fixture('estimate-preview.json'));
	}
	if (req.method === 'POST' && pathname === '/inquiries') {
		const body = await readJson(req);
		if (!body?.name || !body?.email || !body?.zipCode || !body?.eventDate || !body?.eventType) {
			return send(res, 400, { code: 'malformed_request', message: 'Malformed request' });
		}
		submissions.push(body);
		const id = randomUUID();
		return send(
			res,
			201,
			{ id, createdAt: new Date().toISOString() },
			{ location: `/inquiries/${id}` }
		);
	}
	// Test hook: what the app has submitted so far.
	if (req.method === 'GET' && pathname === '/__submissions') return send(res, 200, submissions);

	send(res, 404, { code: 'not_found', message: 'Not found' });
}).listen(port, '127.0.0.1');
