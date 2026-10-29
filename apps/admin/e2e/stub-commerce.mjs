// Minimal stand-in for the fionas-commerce auth endpoints so admin e2e needs no real backend. Like the
// real API it demands a trusted Origin on login/logout and answers with a Secure, HttpOnly,
// host-only session cookie.
import { createServer } from 'node:http';
import { conversationRoute } from './conversation-stub.mjs';
import { randomUUID } from 'node:crypto';
import { dashboardFixture } from './dashboard-fixture.mjs';
import {
	requestFixtures,
	proposalPair,
	appendPayment,
	fixtureMinor,
	mayaId
} from './request-fixture.mjs';
import { issueComposedQuote, previewQuote } from './quote-stub.mjs';
import {
	applyInvoiceRevision,
	applyQuoteRevision,
	ensureHistory,
	previewInvoiceRevision,
	previewQuoteRevision,
	projection,
	recordBooking
} from './revision-stub.mjs';

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
		'fionas.communications.read',
		'fionas.communications.send',
		'fionas.communications.acknowledge',
		'fionas.inquiries.manage',
		'fionas.inquiries.read',
		'commerce.financial-document.read',
		'commerce.financial-document.create',
		'commerce.deposit-requirement.manage',
		'fionas.financial-terms.manage',
		'commerce.payment.record'
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

const zero = (value) => /^-?0+(?:\.0+)?$/.test(value);
// Fixture-only stand-ins for the backend's classification. The admin app never computes these.
const needsClosing = (request) =>
	request.inquiry.lifecycle.stage === 'SERVED' &&
	request.financial.stage === 'INVOICE' &&
	zero(request.financial.reconciliation.balance);
const filters = {
	all: () => true,
	new: (r) => r.inquiry.lifecycle.stage === 'REQUESTED',
	quoted: (r) => r.inquiry.lifecycle.stage === 'QUOTED',
	booked: (r) => ['BOOKED', 'SERVED'].includes(r.inquiry.lifecycle.stage),
	'needs-closing': needsClosing,
	closed: (r) => r.inquiry.lifecycle.stage === 'CLOSED',
	declined: (r) => r.inquiry.lifecycle.stage === 'DECLINED'
};

function summaryOf(requests) {
	const all = Object.values(requests);
	const count = (filter) => all.filter(filters[filter]).length;
	return {
		new: count('new'),
		quoted: count('quoted'),
		booked: count('booked'),
		needsClosing: count('needs-closing')
	};
}

/** `StaffRequestListItemResponse` projected from a session's staff-request fixture. */
function listItem(request) {
	const { inquiry, financial } = request;
	return {
		inquiryId: inquiry.id,
		customerId: inquiry.customerId,
		customerName: inquiry.name,
		customerEmail: inquiry.email,
		eventDate: inquiry.eventDate,
		eventType: inquiry.eventType,
		stage: inquiry.lifecycle.stage,
		needsClosing: needsClosing(request),
		needsReply: request.communication?.needsReply ?? false,
		awaitingReplySince: request.communication?.unacknowledgedSince,
		documentId: financial.id,
		version: financial.version,
		financialStage: financial.stage,
		total: financial.total,
		totalQualifier:
			financial.stage === 'ESTIMATE' && inquiry.requestedService.guestCountIsMinimum
				? 'FROM'
				: 'EXACT',
		balance: financial.reconciliation.balance,
		currency: financial.currency,
		inquiryCreatedAt: inquiry.createdAt,
		latestDocumentVersionAt: financial.createdAt
	};
}

// Like the API's cursor: base64url, bound to the normalized filter and search, opaque to clients.
const encodeCursor = (identity, item) =>
	Buffer.from(JSON.stringify([identity, item.inquiryCreatedAt, item.inquiryId])).toString(
		'base64url'
	);
function decodeCursor(cursor, identity) {
	try {
		const [bound, createdAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString());
		return bound === identity && typeof createdAt === 'string' && typeof id === 'string'
			? { createdAt, id }
			: null;
	} catch {
		return null;
	}
}

/** Mirrors fionas-commerce's listStaffRequests: membership, search, order, cursor, totalCount. */
function listRequests(session, params) {
	const malformed = {
		status: 400,
		body: { code: 'malformed_request', message: 'PRIVATE list diagnostic' }
	};
	if (
		!session.permissions.includes('fionas.inquiries.read') ||
		!session.permissions.includes('commerce.financial-document.read') ||
		session.listMode === 'list-forbidden'
	)
		return { status: 403, body: { code: 'forbidden', message: 'PRIVATE list access diagnostic' } };
	if (session.listMode === 'list-unavailable')
		return {
			status: 500,
			body: { code: 'internal_failure', message: 'PRIVATE list database diagnostic' }
		};
	if (['filter', 'q', 'limit', 'cursor'].some((name) => params.getAll(name).length > 1))
		return malformed;
	const filter = params.get('filter') ?? 'all';
	if (!Object.hasOwn(filters, filter)) return malformed;
	const raw = params.get('q');
	if (raw !== null && (raw.length > 200 || /\p{Cc}/u.test(raw.trim()))) return malformed;
	const q = raw?.trim().toLowerCase() || null;
	const rawLimit = params.get('limit');
	const limit = rawLimit === null ? (session.listPageSize ?? 25) : Number(rawLimit);
	if ((rawLimit !== null && !/^\d+$/.test(rawLimit)) || limit < 1 || limit > 100) return malformed;
	const identity = `${filter}|${q ?? ''}`;
	const cursor = params.get('cursor');
	const after = cursor === null ? null : decodeCursor(cursor, identity);
	if (cursor !== null && !after) return malformed;
	if (session.listMode === 'list-malformed')
		return {
			status: 200,
			body: { items: [{ inquiryId: mayaId, total: 415 }], totalCount: 'many' }
		};
	const matches =
		session.listMode === 'list-empty'
			? []
			: Object.values(session.requests)
					.filter(filters[filter])
					.filter(
						(r) =>
							!q ||
							r.inquiry.name.toLowerCase().includes(q) ||
							r.inquiry.email.toLowerCase().includes(q) ||
							r.inquiry.id === q
					)
					.map(listItem)
					.sort((a, b) =>
						a.inquiryCreatedAt === b.inquiryCreatedAt
							? b.inquiryId.localeCompare(a.inquiryId)
							: Date.parse(b.inquiryCreatedAt) - Date.parse(a.inquiryCreatedAt)
					);
	const remaining = after
		? matches.filter(
				(item) =>
					Date.parse(item.inquiryCreatedAt) < Date.parse(after.createdAt) ||
					(item.inquiryCreatedAt === after.createdAt && item.inquiryId < after.id)
			)
		: matches;
	const page = remaining.slice(0, limit);
	return {
		status: 200,
		body: {
			items: page,
			// CommerceJson omits null: the last page has no nextCursor key at all.
			...(remaining.length > limit && { nextCursor: encodeCursor(identity, page.at(-1)) }),
			totalCount: matches.length
		}
	};
}

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
				'request-read-only',
				'request-no-payment'
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
			previewAttempts: [],
			revisionAttempts: [],
			quoteEpoch: 0,
			paymentAttempts: [],
			fulfillmentAttempts: [],
			declineAttempts: [],
			requestListReads: 0,
			requestListQueries: [],
			listMode: null,
			listPageSize: null,
			requests: requestFixtures(),
			permissions:
				body.username === 'request-read-only'
					? user.permissions.filter(
							(permission) => permission !== 'commerce.financial-document.create'
						)
					: body.username === 'request-no-payment'
						? user.permissions.filter((permission) => permission !== 'commerce.payment.record')
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
		for (const queue of Object.values(projection.workQueue))
			queue.items = queue.items.filter((item) => item.stage !== 'DECLINED');
		projection.workQueue.needsQuote.items = projection.workQueue.needsQuote.items.filter(
			(item) => item.stage !== 'QUOTED'
		);
		// The counts the backend derives from the same state as GET /staff/requests's filters.
		if (session.mode !== 'dashboard-empty') projection.summary = summaryOf(session.requests);
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
			if (body && 'listMode' in body) currentSession.listMode = body.listMode;
			if (body && 'pageSize' in body) currentSession.listPageSize = body.pageSize;
			return send(res, 204);
		}
	}

	if (route === 'GET /staff/requests') {
		if (!currentSession)
			return send(res, 401, { code: 'unauthenticated', message: 'Authentication is required' });
		currentSession.requestListReads++;
		const search = new URL(req.url ?? '/', 'http://stub').search;
		currentSession.requestListQueries.push(search);
		const result = listRequests(currentSession, new URLSearchParams(search));
		return send(res, result.status, result.body, { 'cache-control': 'no-store' });
	}

	if (await conversationRoute(req, res, currentSession, pathname, send, readJson, trustedOrigin))
		return;
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
		const staffRequest = projection(request);
		if (mode === 'request-missing-reconciliation') delete staffRequest.financial.reconciliation;
		return send(res, 200, staffRequest, { 'cache-control': 'no-store' });
	}

	const previewMatch = /^\/staff\/requests\/([^/]+)\/quote-preview$/.exec(pathname);
	if (req.method === 'POST' && previewMatch) {
		if (!currentSession) return send(res, 401);
		const body = await readJson(req);
		currentSession.previewAttempts.push({ inquiryId: previewMatch[1], body });
		if (
			req.headers.origin !== trustedOrigin ||
			!currentSession.permissions.includes('commerce.financial-document.create') ||
			!currentSession.permissions.includes('commerce.deposit-requirement.manage') ||
			!currentSession.permissions.includes('fionas.financial-terms.manage')
		)
			return send(res, 403, {
				code: 'forbidden',
				message: 'PRIVATE preview permission diagnostic'
			});
		const request = currentSession.requests[previewMatch[1]];
		if (!request) return send(res, 404, { code: 'not_found', message: 'PRIVATE preview identity' });
		if (currentSession.mode === 'preview-unavailable')
			return send(res, 500, { code: 'internal_failure', message: 'PRIVATE preview diagnostic' });
		if (request.inquiry.lifecycle.stage === 'DECLINED')
			return send(res, 409, { code: 'illegal_transition', message: 'PRIVATE declined diagnostic' });
		const result = previewQuote(currentSession, request, body);
		return send(res, result.status, result.body, { 'cache-control': 'no-store' });
	}

	// Quote revisions and Invoice amendments. Mirrors fionas-commerce: Quote authority for Quote
	// revisions, Invoice authority (no deposit management) for amendments, a trusted Origin, a stale
	// expected version as `conflict`, and a token that no longer matches as QUOTE_REVIEW_STALE.
	const revisionMatch =
		/^\/staff\/requests\/([^/]+)\/(quote-revision-preview|proposals\/quote-revisions|invoice-revision-preview|invoice-revisions)$/.exec(
			pathname
		);
	if (req.method === 'POST' && revisionMatch) {
		if (!currentSession) return send(res, 401);
		const body = await readJson(req);
		const [, inquiryId, operation] = revisionMatch;
		currentSession.revisionAttempts.push({ inquiryId, operation, body });
		const invoice = operation.startsWith('invoice');
		const publish = operation === 'invoice-revisions' || operation === 'proposals/quote-revisions';
		const needs = invoice
			? ['commerce.financial-document.create', 'fionas.financial-terms.manage']
			: [
					'commerce.financial-document.create',
					'commerce.deposit-requirement.manage',
					'fionas.financial-terms.manage'
				];
		const refusal = (status, code, message = 'PRIVATE revision diagnostic') =>
			send(res, status, { code, message });
		if (
			req.headers.origin !== trustedOrigin ||
			needs.some((permission) => !currentSession.permissions.includes(permission)) ||
			currentSession.mode === 'revision-forbidden'
		)
			return refusal(403, 'forbidden');
		const request = currentSession.requests[inquiryId];
		if (!request) return refusal(404, 'not_found');
		if (!publish && currentSession.mode === 'revision-preview-unavailable')
			return refusal(500, 'internal_failure');
		if (publish && currentSession.mode === 'revision-conflict') return refusal(409, 'conflict');
		const run = invoice ? previewInvoiceRevision : previewQuoteRevision;
		if (!publish) {
			const reviewed = run(currentSession, request, body);
			return send(res, reviewed.status, reviewed.body, { 'cache-control': 'no-store' });
		}
		if (typeof body?.reviewToken !== 'string') return refusal(400, 'malformed_request');
		if (currentSession.mode === 'quote-review-stale') {
			// Something authoritative changed after review: tokens move on, and staff must re-approve.
			currentSession.mode = user.username;
			currentSession.quoteEpoch++;
			return refusal(409, 'QUOTE_REVIEW_STALE');
		}
		const { reviewToken, ...previewBody } = body;
		const reviewed = run(currentSession, request, previewBody);
		if (reviewed.status !== 200) return send(res, reviewed.status, reviewed.body);
		const token = invoice ? reviewed.body.reviewToken : reviewed.body.quote.reviewToken;
		if (token !== reviewToken) return refusal(409, 'QUOTE_REVIEW_STALE');
		if (currentSession.mode === 'revision-unavailable') return refusal(500, 'internal_failure');
		const result = invoice
			? applyInvoiceRevision(request, reviewed.body, previewBody, user.id)
			: applyQuoteRevision(request, reviewed.body, previewBody, user.id);
		// Committed, then the response is lost: only a reload can tell.
		if (currentSession.mode === 'revision-ambiguous') return refusal(500, 'internal_failure');
		return send(res, 200, result, { 'cache-control': 'no-store' });
	}

	// Optional history reads; the workspace must stay usable when they fail.
	const historyMatch =
		/^\/financial-documents\/([^/]+)\/(history|deposit-requirement\/history)$/.exec(pathname);
	if (req.method === 'GET' && historyMatch) {
		if (!currentSession) return send(res, 401);
		if (currentSession.mode === 'history-unavailable')
			return send(res, 500, { code: 'internal_failure', message: 'PRIVATE history diagnostic' });
		const request = Object.values(currentSession.requests).find(
			(candidate) => candidate.financial.id === historyMatch[1]
		);
		if (!request) return send(res, 404, { code: 'not_found', message: 'PRIVATE history' });
		const history = ensureHistory(request);
		if (currentSession.mode === 'history-malformed')
			return send(res, 200, { id: request.financial.id, versions: 'many' });
		return send(
			res,
			200,
			historyMatch[2] === 'history'
				? { id: request.financial.id, inquiryId: request.inquiry.id, versions: history.versions }
				: { revisions: history.deposits },
			{ 'cache-control': 'no-store' }
		);
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
			!currentSession.permissions.includes('fionas.financial-terms.manage') ||
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
				code:
					request.financial.stage !== 'ESTIMATE' || request.inquiry.lifecycle.stage === 'DECLINED'
						? 'illegal_transition'
						: 'conflict',
				message: 'PRIVATE stale ledger diagnostic'
			});
		}
		if (body && ('lines' in body || 'reviewToken' in body)) {
			if (
				Object.keys(body).some(
					(k) =>
						!['expectedDocumentVersion', 'lines', 'reviewToken', 'servicePlan', 'terms'].includes(k)
				) ||
				!['expectedDocumentVersion', 'lines', 'reviewToken', 'terms'].every((k) => k in body)
			)
				return send(res, 400, {
					code: 'malformed_request',
					message: 'PRIVATE envelope diagnostic'
				});
			if (currentSession.mode === 'quote-review-stale') {
				// Something authoritative changed after review: tokens move on, and staff must re-approve.
				currentSession.mode = user.username;
				currentSession.quoteEpoch++;
				return send(res, 409, { code: 'QUOTE_REVIEW_STALE', message: 'PRIVATE stale review' });
			}
			const { reviewToken, ...previewBody } = body;
			const reviewed = previewQuote(currentSession, request, previewBody);
			if (reviewed.status !== 200) return send(res, reviewed.status, reviewed.body);
			if (reviewed.body.reviewToken !== reviewToken)
				return send(res, 409, { code: 'QUOTE_REVIEW_STALE', message: 'PRIVATE stale review' });
			if (currentSession.mode === 'proposal-unavailable')
				return send(res, 500, {
					code: 'internal_failure',
					message: 'PRIVATE quote transaction diagnostic'
				});
			issueComposedQuote(request, reviewed.body, body.terms, user.id);
			if (currentSession.mode === 'proposal-ambiguous')
				return send(res, 500, {
					code: 'internal_failure',
					message: 'PRIVATE post-commit failure diagnostic'
				});
			return send(
				res,
				200,
				{
					proposal: request.proposal,
					financial: request.financial,
					depositRequirement: request.depositRequirement,
					servicePlan: request.servicePlan
				},
				{ 'cache-control': 'no-store' }
			);
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
		request.proposalHistory = [structuredClone(pair.proposal)];
		request.servicePlanHistory = [];
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

	const fulfillmentMatch = /^\/inquiries\/([^/]+)\/(served|close)$/.exec(pathname);
	if (req.method === 'POST' && fulfillmentMatch) {
		if (!currentSession) return send(res, 401);
		let body = '';
		for await (const chunk of req) body += chunk;
		const [, inquiryId, operation] = fulfillmentMatch;
		currentSession.fulfillmentAttempts.push({ inquiryId, operation, body });
		const refusal = (status) =>
			send(res, status, { code: 'failure', message: 'PRIVATE fulfillment diagnostic' });
		if (
			req.headers.origin !== trustedOrigin ||
			!currentSession.permissions.includes('fionas.inquiries.manage') ||
			currentSession.mode === 'fulfillment-forbidden'
		)
			return refusal(403);
		if (body !== '') return refusal(422);
		const request = currentSession.requests[inquiryId];
		if (!request || currentSession.mode === 'fulfillment-not-found') return refusal(404);
		if (
			request.financial.stage !== 'INVOICE' ||
			request.inquiry.lifecycle.stage !== (operation === 'served' ? 'BOOKED' : 'SERVED') ||
			(operation === 'close' &&
				!/^-?0+(?:\.0+)?$/.test(request.financial.reconciliation.balance)) ||
			currentSession.mode === 'fulfillment-conflict'
		)
			return refusal(409);
		if (currentSession.mode === 'fulfillment-unavailable') return refusal(500);
		request.inquiry.lifecycle.stage = operation === 'served' ? 'SERVED' : 'CLOSED';
		request.inquiry.lifecycle[operation === 'served' ? 'served' : 'closed'] = {
			occurredAt: operation === 'served' ? '2026-10-06T23:42:00Z' : '2026-10-07T00:18:00Z',
			principalKind: 'USER',
			principalId: user.id
		};
		if (currentSession.mode === 'fulfillment-ambiguous') return refusal(500);
		return send(res, 200, request.inquiry.lifecycle, { 'cache-control': 'no-store' });
	}

	// Mirrors fionas-commerce's declineInquiryRoute: staff USER with fionas.inquiries.manage from a
	// trusted origin; exactly { expectedDocumentVersion, reason }; reason trimmed, 1–500 characters;
	// a stale version is `conflict`, anything but REQUESTED is `illegal_transition`; no rebasing.
	const declineMatch = /^\/inquiries\/([^/]+)\/decline$/.exec(pathname);
	if (req.method === 'POST' && declineMatch) {
		if (!currentSession) return send(res, 401);
		let raw = '';
		for await (const chunk of req) raw += chunk;
		const inquiryId = declineMatch[1];
		let body;
		try {
			body = JSON.parse(raw);
		} catch {
			body = null;
		}
		currentSession.declineAttempts.push({ inquiryId, body, raw });
		const refusal = (status, code = 'failure') =>
			send(res, status, { code, message: 'PRIVATE decline diagnostic' });
		if (
			req.headers.origin !== trustedOrigin ||
			!currentSession.permissions.includes('fionas.inquiries.manage') ||
			currentSession.mode === 'decline-forbidden'
		)
			return refusal(403, 'forbidden');
		if (
			!body ||
			typeof body !== 'object' ||
			Object.keys(body).some((key) => !['expectedDocumentVersion', 'reason'].includes(key)) ||
			!Number.isInteger(body.expectedDocumentVersion) ||
			typeof body.reason !== 'string'
		)
			return refusal(400, 'malformed_request');
		const reason = body.reason.trim();
		if (body.expectedDocumentVersion < 1 || !reason || reason.length > 500)
			return refusal(422, 'validation_failed');
		const request = currentSession.requests[inquiryId];
		if (!request || currentSession.mode === 'decline-not-found') return refusal(404, 'not_found');
		if (
			request.financial.version !== body.expectedDocumentVersion ||
			currentSession.mode === 'decline-conflict'
		)
			return refusal(409, 'conflict');
		if (request.inquiry.lifecycle.stage !== 'REQUESTED' || request.financial.stage !== 'ESTIMATE')
			return refusal(409, 'illegal_transition');
		if (currentSession.mode === 'decline-unavailable') return refusal(500, 'internal_failure');
		request.inquiry.lifecycle.stage = 'DECLINED';
		request.inquiry.lifecycle.declined = {
			occurredAt: '2026-10-20T20:00:00Z',
			principalKind: 'USER',
			principalId: user.id,
			reason,
			documentVersion: request.financial.version
		};
		// Committed, then the response is lost: only a reload can tell.
		if (currentSession.mode === 'decline-ambiguous') return refusal(500, 'internal_failure');
		return send(res, 200, request.inquiry.lifecycle, { 'cache-control': 'no-store' });
	}

	const paymentMatch = /^\/financial-documents\/([^/]+)\/payments$/.exec(pathname);
	if (req.method === 'POST' && paymentMatch) {
		if (!currentSession) return send(res, 401);
		const body = await readJson(req);
		currentSession.paymentAttempts.push({ documentId: paymentMatch[1], body });
		const refusal = (status) =>
			send(res, status, { code: 'failure', message: 'PRIVATE payment diagnostic' });
		if (
			req.headers.origin !== trustedOrigin ||
			!currentSession.permissions.includes('commerce.payment.record') ||
			currentSession.mode === 'payment-forbidden'
		)
			return refusal(403);
		const request = Object.values(currentSession.requests).find(
			(request) => request.financial.id === paymentMatch[1]
		);
		if (!request || currentSession.mode === 'payment-not-found') return refusal(404);
		const deposit = request.financial.stage === 'QUOTE';
		if (
			body?.documentVersion !== request.financial.version ||
			currentSession.mode === 'payment-conflict'
		)
			return refusal(409);
		if (
			!['CASH', 'CHECK', 'OTHER'].includes(body?.method) ||
			Object.keys(body ?? {})
				.sort()
				.join(',') !==
				(deposit
					? 'amount,documentVersion,expectedProposalId,method'
					: 'amount,documentVersion,method') ||
			currentSession.mode === 'payment-invalid'
		)
			return refusal(422);
		let amount;
		try {
			amount = fixtureMinor(body.amount);
		} catch {
			return refusal(422);
		}
		if (amount <= 0n || amount > fixtureMinor(request.financial.reconciliation.balance))
			return refusal(422);
		if (deposit) {
			if (
				request.inquiry.lifecycle.stage !== 'QUOTED' ||
				request.depositRequirement.state !== 'ACTIVE' ||
				request.depositRequirement.satisfied ||
				request.payments.some((history) =>
					history.allocations.some((allocation) => allocation.documentId === request.financial.id)
				)
			)
				return refusal(409);
			if (body.expectedProposalId !== request.proposal?.id) return refusal(409);
			if (amount !== fixtureMinor(request.depositRequirement.requiredAmount.amount))
				return refusal(422);
		} else if (
			request.financial.stage !== 'INVOICE' ||
			!['BOOKED', 'SERVED'].includes(request.inquiry.lifecycle.stage)
		)
			return refusal(409);
		if (currentSession.mode === 'payment-unavailable') return refusal(500);
		const response = appendPayment(request, body.amount, body.method, body.documentVersion);
		if (deposit) {
			ensureHistory(request);
			request.depositRequirement.satisfied = true;
			request.financial.previousVersion = request.financial.version;
			request.financial.version++;
			request.financial.stage = 'INVOICE';
			request.inquiry.lifecycle.stage = 'BOOKED';
			recordBooking(request);
		}
		if (currentSession.mode === 'payment-ambiguous') return refusal(500);
		return send(res, 201, response, { 'cache-control': 'no-store' });
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
