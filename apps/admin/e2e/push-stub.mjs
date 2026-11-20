// Session-isolated stand-in for commerce's staff Web Push routes (fionas-commerce PR #46,
// docs/staff-push-notifications.md). Like the real API: a trusted Origin on unsafe methods,
// no-store answers, 503 push_notifications_disabled when off, the same endpoint keeps its id,
// another account's endpoint is 409, and one Idempotency-Key names one test. Endpoints and keys
// never appear in answers. State is keyed by the session token and survives logout, so a test
// can check what sign-out removed.
import { randomUUID } from 'node:crypto';

/** A valid-looking uncompressed P-256 public key, base64url (65 bytes). */
export const VAPID_PUBLIC_KEY = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString(
	'base64url'
);
const states = new Map();
const noStore = { 'cache-control': 'no-store' };

function stateFor(token) {
	if (!states.has(token))
		states.set(token, {
			mode: 'enabled',
			devices: [],
			tests: {},
			keys: {},
			calls: [],
			// Endpoints the stub treats as enrolled for another staff account.
			foreignEndpoints: [],
			// The statuses successive status reads walk through (the last one sticks).
			plan: ['queued', 'push_accepted'],
			failureReason: null,
			// Commit the next N tests but lose the answer (500), as a timeout would.
			loseTestAnswers: 0
		});
	return states.get(token);
}

/** What commerce answers about a device: never its endpoint or keys. */
const publicDevice = (device) =>
	Object.fromEntries(
		['subscriptionId', 'label', 'service', 'state', 'enrolledAt', 'refreshedAt', 'expirationTime']
			.filter((field) => device[field] !== undefined)
			.map((field) => [field, device[field]])
	);

export async function pushRoute(req, res, token, session, pathname, send, readJson, trustedOrigin) {
	if (pathname === '/__test/push') {
		if (!token) {
			send(res, 401);
			return true;
		}
		const state = stateFor(token);
		if (req.method === 'GET') {
			send(res, 200, state);
			return true;
		}
		Object.assign(state, (await readJson(req)) ?? {});
		send(res, 204);
		return true;
	}
	if (!pathname.startsWith('/staff/notifications/')) return false;
	if (!session) {
		send(res, 401, { code: 'unauthenticated', message: 'Authentication is required' });
		return true;
	}
	const state = stateFor(token);
	const reply = (status, body) => send(res, status, body, noStore);
	if (req.method !== 'GET' && req.headers.origin !== trustedOrigin) {
		reply(403, { code: 'forbidden', message: 'The browser origin is not trusted' });
		return true;
	}
	const route = `${req.method} ${pathname}`;
	const body = req.method === 'POST' ? await readJson(req) : undefined;
	state.calls.push({
		route,
		...(body !== undefined && { body }),
		...(req.headers['idempotency-key'] && { key: req.headers['idempotency-key'] })
	});

	if (route === 'GET /staff/notifications/config') {
		reply(
			200,
			state.mode === 'disabled'
				? { enabled: false }
				: { enabled: true, vapidPublicKey: VAPID_PUBLIC_KEY }
		);
		return true;
	}
	if (state.mode === 'disabled') {
		reply(503, { code: 'push_notifications_disabled', message: 'PRIVATE disabled diagnostic' });
		return true;
	}
	const active = () => state.devices.filter((device) => !device.revoked);

	if (route === 'POST /staff/notifications/subscriptions') {
		const subscription = body?.subscription;
		if (
			typeof subscription?.endpoint !== 'string' ||
			!subscription.endpoint.startsWith('https://') ||
			typeof subscription?.keys?.p256dh !== 'string' ||
			typeof subscription?.keys?.auth !== 'string'
		) {
			reply(422, { code: 'validation_failed', message: 'PRIVATE validation diagnostic' });
			return true;
		}
		if (state.foreignEndpoints.includes(subscription.endpoint)) {
			reply(409, { code: 'push_endpoint_in_use', message: 'PRIVATE other account diagnostic' });
			return true;
		}
		const now = new Date().toISOString();
		const label =
			typeof body.label === 'string' && body.label.trim() ? body.label.trim() : undefined;
		const existing = active().find((device) => device.endpoint === subscription.endpoint);
		if (existing) {
			Object.assign(existing, { keys: subscription.keys, refreshedAt: now });
			if (label) existing.label = label;
			else delete existing.label;
			reply(200, publicDevice(existing));
			return true;
		}
		const device = {
			subscriptionId: randomUUID(),
			...(label && { label }),
			service: 'FCM',
			state: 'ACTIVE',
			enrolledAt: now,
			refreshedAt: now,
			endpoint: subscription.endpoint,
			keys: subscription.keys
		};
		state.devices.push(device);
		reply(201, publicDevice(device));
		return true;
	}
	if (route === 'GET /staff/notifications/subscriptions') {
		reply(200, { devices: active().map(publicDevice) });
		return true;
	}
	const remove = /^\/staff\/notifications\/subscriptions\/([^/]+)$/.exec(pathname);
	if (req.method === 'DELETE' && remove) {
		const device = state.devices.find((d) => d.subscriptionId === remove[1]);
		if (!device) reply(404, { code: 'not_found', message: 'PRIVATE not found diagnostic' });
		else {
			device.revoked = true;
			send(res, 204, undefined, noStore);
		}
		return true;
	}
	if (route === 'POST /staff/notifications/test') {
		const key = req.headers['idempotency-key'];
		if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) {
			reply(400, { code: 'malformed_request', message: 'Malformed request' });
			return true;
		}
		const previous = state.keys[key];
		if (previous && previous.subscriptionId !== body?.subscriptionId) {
			reply(409, { code: 'IDEMPOTENCY_KEY_REUSED', message: 'PRIVATE key diagnostic' });
			return true;
		}
		let test = previous && state.tests[previous.notificationId];
		if (!test) {
			if (!active().some((device) => device.subscriptionId === body?.subscriptionId)) {
				reply(404, { code: 'not_found', message: 'PRIVATE not found diagnostic' });
				return true;
			}
			test = {
				notificationId: randomUUID(),
				subscriptionId: body.subscriptionId,
				plan: [...state.plan],
				failureReason: state.failureReason,
				reads: 0,
				queuedAt: new Date().toISOString()
			};
			state.tests[test.notificationId] = test;
			state.keys[key] = {
				notificationId: test.notificationId,
				subscriptionId: test.subscriptionId
			};
		}
		if (state.loseTestAnswers > 0) {
			state.loseTestAnswers--;
			reply(500, { code: 'internal_failure', message: 'PRIVATE lost answer' });
			return true;
		}
		reply(202, { notificationId: test.notificationId, status: test.plan[0] });
		return true;
	}
	const status = /^\/staff\/notifications\/([^/]+)$/.exec(pathname);
	if (req.method === 'GET' && status) {
		const test = state.tests[status[1]];
		if (!test) {
			reply(404, { code: 'not_found', message: 'PRIVATE not found diagnostic' });
			return true;
		}
		test.reads++;
		const current = test.plan[Math.min(test.reads, test.plan.length - 1)];
		const terminal = ['push_accepted', 'push_failed', 'skipped'].includes(current);
		reply(200, {
			notificationId: test.notificationId,
			kind: 'test',
			subscriptionId: test.subscriptionId,
			status: current,
			attempts: current === 'queued' ? 0 : test.reads,
			queuedAt: test.queuedAt,
			...(current !== 'queued' && { lastAttemptAt: new Date().toISOString() }),
			...(terminal && { completedAt: new Date().toISOString() }),
			...(current === 'push_accepted' && { providerCode: 201 }),
			...(current !== 'queued' &&
				current !== 'push_accepted' &&
				test.failureReason && {
					failureReason: test.failureReason
				})
		});
		return true;
	}
	reply(404, { code: 'not_found', message: 'Not found' });
	return true;
}
