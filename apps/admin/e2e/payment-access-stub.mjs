// Session-isolated stand-in for commerce's staff payment-access and attempt endpoints
// (fionas-commerce PR #36). Like the real API: all three permissions, a trusted Origin on POST,
// bodyless POSTs, issue/rotate only for QUOTED/BOOKED/SERVED, and no URL once revoked.
import { randomBytes, randomUUID } from 'node:crypto';

const REQUIRED = [
	'fionas.payment-access.manage',
	'fionas.inquiries.read',
	'commerce.financial-document.read'
];
const publicOrigin = 'https://www.fionasicecream.example';

function describe(access) {
	if (!access) return { revoked: false };
	return access.revoked
		? { publicId: access.publicId, revoked: true }
		: {
				publicId: access.publicId,
				revoked: false,
				url: `${publicOrigin}/pay/${access.publicId}#${access.secret}`
			};
}

export function paymentAttemptFixture(overrides = {}) {
	return {
		id: randomUUID(),
		purpose: 'INVOICE',
		authorizedMinor: 10000,
		documentVersion: 2,
		businessRevision: 2,
		state: 'OPEN',
		outcome: 'PENDING',
		createdAt: '2026-08-01T18:00:00Z',
		expiresAt: '2026-08-01T19:00:00Z',
		sessionId: 'cs_test_e2e',
		...overrides
	};
}

export async function paymentAccessRoute(
	req,
	res,
	session,
	pathname,
	send,
	readJson,
	trustedOrigin
) {
	if (pathname === '/__test/payments') {
		if (!session) {
			send(res, 401);
			return true;
		}
		session.payments ??= { access: {}, attempts: {}, calls: [], mode: null };
		if (req.method === 'GET') {
			send(res, 200, session.payments);
			return true;
		}
		const update = (await readJson(req)) ?? {};
		if ('mode' in update) session.payments.mode = update.mode;
		// What later reconciles answer: { result: { state, outcome, ledgerPaymentId? } } applied to the
		// attempt (plus an optional `request` commerce would then project), or { status, code }.
		if ('reconcile' in update) session.payments.reconcile = update.reconcile;
		// true: the attempt list read fails (503), as an optional diagnostics read can.
		if ('attemptsUnavailable' in update)
			session.payments.attemptsUnavailable = update.attemptsUnavailable;
		if (update.attempts) session.payments.attempts[update.inquiryId] = update.attempts;
		if (update.access === null) delete session.payments.access[update.inquiryId];
		else if (update.access)
			session.payments.access[update.inquiryId] = {
				publicId: update.access.publicId ?? randomUUID(),
				secret: randomBytes(32).toString('base64url'),
				revoked: !!update.access.revoked
			};
		send(res, 204);
		return true;
	}
	const match =
		/^\/staff\/requests\/([^/]+)\/(payment-access(?:\/rotate|\/revoke)?|payment-attempts(?:\/([^/]+)\/reconcile)?)$/.exec(
			pathname
		);
	if (!match) return false;
	if (!session) {
		send(res, 401, { code: 'unauthenticated', message: 'Authentication is required' });
		return true;
	}
	session.payments ??= { access: {}, attempts: {}, calls: [], mode: null };
	const state = session.payments;
	const [, inquiryId, operation, attemptId] = match;
	state.calls.push({ method: req.method, path: pathname, origin: req.headers.origin ?? null });
	const headers = { 'cache-control': 'no-store' };
	const missing = REQUIRED.some((permission) => !session.permissions.includes(permission));
	if (missing || (req.method === 'POST' && req.headers.origin !== trustedOrigin)) {
		send(res, 403, { code: 'forbidden', message: 'PRIVATE permission diagnostic' }, headers);
		return true;
	}
	if (state.mode === 'disabled') {
		send(res, 503, { code: 'stripe_disabled', message: 'Online payments are disabled' }, headers);
		return true;
	}
	const request = session.requests[inquiryId];
	if (!request) {
		send(res, 404, { code: 'not_found', message: 'PRIVATE' }, headers);
		return true;
	}
	const stage = request.inquiry.lifecycle.stage;
	const access = state.access[inquiryId];
	if (operation.startsWith('payment-attempts')) {
		const attempts = (state.attempts[inquiryId] ??= []);
		if (req.method === 'GET' && !attemptId) {
			if (state.attemptsUnavailable)
				send(res, 503, { code: 'unavailable', message: 'PRIVATE' }, headers);
			else send(res, 200, { items: attempts }, headers);
			return true;
		}
		const attempt = attempts.find((item) => item.id === attemptId);
		if (req.method !== 'POST' || !attempt) {
			send(res, 404, { code: 'not_found', message: 'PRIVATE' }, headers);
			return true;
		}
		const plan = state.reconcile;
		if (plan?.status) {
			send(
				res,
				plan.status,
				{ code: plan.code ?? 'internal_failure', message: 'PRIVATE' },
				headers
			);
			return true;
		}
		if (plan?.result) Object.assign(attempt, plan.result);
		else if (state.mode === 'reconcile-expire' && attempt.state === 'OPEN')
			attempt.state = 'EXPIRED';
		if (plan?.request) session.requests[inquiryId] = plan.request;
		send(
			res,
			200,
			{
				attemptId: attempt.id,
				uiMode: 'HOSTED',
				url: 'https://checkout.stripe.com/c/pay/cs_test_private',
				state: attempt.state,
				outcome: attempt.outcome
			},
			headers
		);
		return true;
	}
	if (req.method === 'GET') {
		send(res, 200, describe(access), headers);
		return true;
	}
	if (state.mode === 'mutation-500') {
		send(res, 500, { code: 'internal_failure', message: 'PRIVATE' }, headers);
		return true;
	}
	const action = operation.endsWith('/rotate')
		? 'rotate'
		: operation.endsWith('/revoke')
			? 'revoke'
			: 'issue';
	if (action === 'revoke') {
		if (access) access.revoked = true;
		send(res, 200, describe(access), headers);
		return true;
	}
	if (action === 'issue' && access && !access.revoked) {
		send(res, 200, describe(access), headers);
		return true;
	}
	if (!['QUOTED', 'BOOKED', 'SERVED'].includes(stage)) {
		send(
			res,
			409,
			{ code: 'illegal_transition', message: 'PRIVATE lifecycle diagnostic' },
			headers
		);
		return true;
	}
	state.access[inquiryId] = {
		publicId: access?.publicId ?? randomUUID(),
		secret: randomBytes(32).toString('base64url'),
		revoked: false
	};
	send(res, 200, describe(state.access[inquiryId]), headers);
	return true;
}
