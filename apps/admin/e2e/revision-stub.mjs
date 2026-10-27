// Synthetic test ledger only. Mirrors the shape and refusal codes of fionas-commerce's Quote and
// Invoice revision endpoints so the admin can be exercised end to end; it is not a pricing authority.
import { createHash } from 'node:crypto';
import { composeLines, composePlan, decimal, minor } from './quote-stub.mjs';
import { resolveDepositAmount } from './request-fixture.mjs';

/** @typedef {import('../src/lib/request-contract.js').CurrentStaffRequest} Request */

export const staffUserId = '00000000-0000-0000-0000-000000000001';
let clock = 0;
/** Strictly increasing instants, so approvals and publications always read in order. */
const stamp = () =>
	new Date(Date.parse('2026-10-20T18:00:00Z') + ++clock * 60_000)
		.toISOString()
		.replace('.000Z', 'Z');

/** @param {number} status @param {string} code @param {string[]} [violations] */
const refuse = (status, code, violations = []) => ({
	status,
	body: {
		code,
		message: 'PRIVATE revision diagnostic',
		violations: violations.map((v) => ({ code: v }))
	}
});

/** @param {Request['financial']} financial @param {number} version @param {string} stage */
function snapshot(financial, version, stage) {
	const { reconciliation, ...rest } = structuredClone(financial);
	void reconciliation;
	return { ...rest, version, stage, previousVersion: version > 1 ? version - 1 : undefined };
}
/** @param {Extract<Request['depositRequirement'], {state: 'ACTIVE'}>} deposit */
function depositSnapshot(deposit) {
	const { satisfied, ...rest } = structuredClone(deposit);
	void satisfied;
	return rest;
}
/**
 * Immutable snapshots, kept beside a fixture. Built lazily from the current state the first time a
 * mutation needs them, so every mutation must call this *before* it changes anything.
 * @param {Request & {__history?: {versions: object[], deposits: object[]}}} request
 */
export function ensureHistory(request) {
	if (request.__history) return request.__history;
	const f = request.financial;
	const quoteVersion = request.proposal?.documentVersion;
	const versions = [];
	for (let v = 1; v <= f.version; v++)
		versions.push(
			snapshot(
				f,
				v,
				v === f.version
					? f.stage
					: !quoteVersion || v < quoteVersion
						? 'ESTIMATE'
						: v === quoteVersion
							? 'QUOTE'
							: 'INVOICE'
			)
		);
	const deposits =
		request.depositRequirement.state === 'ACTIVE'
			? [depositSnapshot(request.depositRequirement)]
			: [];
	request.__history = { versions, deposits };
	return request.__history;
}
/** Records the booking that follows an exact deposit: Quote vN becomes Invoice vN+1. */
export function recordBooking(/** @type {Request} */ request) {
	const h = ensureHistory(request);
	h.versions.push(snapshot(request.financial, request.financial.version, 'INVOICE'));
	if (request.servicePlan) request.acceptedServicePlan = request.servicePlan;
}
/** The staff-request projection: everything but the fixture's own bookkeeping. */
export function projection(/** @type {Request & {__history?: unknown}} */ request) {
	const { __history, ...rest } = structuredClone(request);
	void __history;
	return rest;
}

/** @param {Request} request */
export const currentLines = (request) =>
	request.financial.lines.map((l) => ({
		lineItemId: l.id,
		description: l.description,
		...(l.subDescription ? { subDescription: l.subDescription } : {}),
		...(l.quantity ? { quantity: l.quantity } : {}),
		unitPrice: l.unitPrice,
		taxAmount: l.taxAmount,
		currency: l.currency
	}));

/** @param {unknown} a @param {unknown} b */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Resolves what the plan action does to the current commitment. Throws a refusal response.
 * @param {Request} request
 * @param {{servicePlanAction?: string, servicePlan?: import('../src/lib/quote-contract.js').ServicePlanRequest}} body
 * @param {{id: string, key?: string}[]} lines
 */
function resolvePlan(request, body, lines) {
	const action = body.servicePlanAction ?? 'RETAIN';
	if (!['RETAIN', 'REPLACE', 'CLEAR'].includes(action)) throw refuse(400, 'malformed_request');
	// No implicit replacement from field presence, in either direction.
	if ((action === 'REPLACE') !== (body.servicePlan != null)) throw refuse(422, 'validation_failed');
	const effective = request.effectiveServicePlan;
	const current = effective && !effective.cleared ? effective : null;
	const view = (/** @type {NonNullable<typeof current>} */ plan) => ({
		description: /** @type {string} */ (plan.description),
		...(plan.guestCount ? { guestCount: plan.guestCount } : {}),
		...(plan.durationMinutes ? { durationMinutes: plan.durationMinutes } : {}),
		items: plan.items,
		lineNotes: plan.lineNotes
	});
	if (action === 'REPLACE') {
		let plan;
		try {
			plan = composePlan(/** @type {*} */ (body.servicePlan), lines);
		} catch {
			throw refuse(422, 'validation_failed', ['SERVICE_PLAN_LINE_NOT_FOUND']);
		}
		const proposed = {
			description: plan.description,
			...(plan.guestCount ? { guestCount: plan.guestCount } : {}),
			...(plan.durationMinutes ? { durationMinutes: plan.durationMinutes } : {}),
			items: plan.items,
			lineNotes: plan.lineNotes
		};
		return { action, plan: proposed, change: !current || !same(view(current), proposed) };
	}
	if (action === 'CLEAR') return { action, plan: null, change: !!current };
	if (current && current.lineNotes.some((n) => !lines.some((l) => l.id === n.lineItemId)))
		throw refuse(422, 'validation_failed', ['SERVICE_PLAN_LINE_NOT_FOUND']);
	return { action, plan: current ? view(current) : null, change: false };
}

/** @param {unknown} terms */
const canonicalTerms = (terms) => {
	const t = /** @type {*} */ (terms);
	return t.type === 'PERCENTAGE'
		? { type: t.type, percentage: t.percentage }
		: { type: t.type, amount: t.amount, currency: t.currency };
};

/** @param {{quoteEpoch?: number}} session @param {Request} request @param {*} body */
export function previewQuoteRevision(session, request, body) {
	try {
		if (request.inquiry.lifecycle.stage !== 'QUOTED' || request.financial.stage !== 'QUOTE')
			return refuse(409, 'illegal_transition');
		const deposit = request.depositRequirement;
		if (deposit.state !== 'ACTIVE') return refuse(409, 'illegal_transition');
		if (
			body?.expectedDocumentVersion !== request.financial.version ||
			body?.expectedDepositRequirementRevision !== deposit.revision
		)
			return refuse(409, 'conflict');
		if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 100)
			return refuse(422, 'validation_failed');
		let composed;
		try {
			composed = composeLines(request, body.lines);
		} catch {
			return refuse(422, 'validation_failed', ['LINE_NOT_IN_REVIEWED_DOCUMENT']);
		}
		if (composed.total <= 0n) return refuse(422, 'validation_failed', ['QUOTE_TOTAL_NOT_POSITIVE']);
		const plan = resolvePlan(request, body, composed.lines);
		const termsChanged = !same(canonicalTerms(body.terms), canonicalTerms(deposit.terms));
		const depositChange = composed.financialChange || termsChanged;
		if (!composed.financialChange && !plan.change && !termsChanged)
			return refuse(422, 'validation_failed', ['NO_MATERIAL_CHANGE']);
		const total = decimal(composed.total);
		const current = request.effectiveServicePlan;
		const reviewToken = createHash('sha256')
			.update(
				JSON.stringify({
					kind: 'quote-revision',
					body,
					epoch: session.quoteEpoch ?? 0,
					proposal: request.proposal?.id,
					plan: current?.revision ?? null
				})
			)
			.digest('hex');
		return {
			status: 200,
			body: {
				quote: {
					inquiryId: request.inquiry.id,
					documentId: request.financial.id,
					reviewedDocumentVersion: request.financial.version,
					// On a revision this is the reviewed current Quote total, not an Estimate.
					estimateTotal: request.financial.total,
					financialChange: composed.financialChange,
					quoteVersion: request.financial.version + (composed.financialChange ? 1 : 0),
					lines: composed.lines,
					subtotal: decimal(composed.lines.reduce((sum, l) => sum + minor(l.subtotal), 0n)),
					taxAmount: decimal(composed.lines.reduce((sum, l) => sum + minor(l.taxAmount), 0n)),
					total,
					currency: request.financial.currency,
					deposit: {
						terms: body.terms,
						requiredAmount: {
							amount: resolveDepositAmount(total, body.terms, request.financial.currency),
							currency: request.financial.currency
						}
					},
					...(plan.plan ? { servicePlan: plan.plan } : {}),
					reviewToken
				},
				currentProposalId: request.proposal?.id,
				reviewedDepositRequirementRevision: deposit.revision,
				...(current ? { currentServicePlanRevision: current.revision } : {}),
				...(current || plan.change
					? { resultingServicePlanRevision: (current?.revision ?? 0) + (plan.change ? 1 : 0) }
					: {}),
				servicePlanChange: plan.change,
				depositChange
			}
		};
	} catch (refusal) {
		if (refusal && typeof refusal === 'object' && 'status' in refusal)
			return /** @type {*} */ (refusal);
		throw refusal;
	}
}

/**
 * Appends the service approval a revision makes, if any, and returns it.
 * @param {Request} request
 * @param {{action: string, plan: *, change: boolean}} plan
 * @param {number} reviewedVersion @param {string} userId
 */
function approve(request, plan, reviewedVersion, userId) {
	if (!plan.change) return null;
	const cleared = plan.action === 'CLEAR';
	const approval = {
		documentId: request.financial.id,
		documentVersion: request.financial.version,
		reviewedDocumentVersion: reviewedVersion,
		...(cleared ? { items: [], lineNotes: [] } : plan.plan),
		approvedAt: stamp(),
		approvedBy: userId,
		revision: (request.servicePlanHistory.at(-1)?.revision ?? 0) + 1,
		cleared
	};
	request.servicePlanHistory.push(approval);
	request.effectiveServicePlan = approval;
	return approval;
}

/**
 * Publishes a reviewed Quote revision: a new proposal identity always; a new financial version
 * only for a financial change; a new service approval only for a service change.
 * @param {Request} request @param {*} reviewed the preview response @param {*} body @param {string} userId
 */
export function applyQuoteRevision(request, reviewed, body, userId) {
	const history = ensureHistory(request);
	const quote = reviewed.quote;
	const f = request.financial;
	const reviewedVersion = f.version;
	const planResolution = resolvePlan(request, body, quote.lines);
	if (quote.financialChange) {
		f.previousVersion = f.version;
		f.version = quote.quoteVersion;
		f.createdAt = stamp();
		f.lines = quote.lines.map((/** @type {*} */ { origin, key, ...line }) => {
			void origin;
			void key;
			return line;
		});
		Object.assign(f, {
			subtotal: quote.subtotal,
			taxAmount: quote.taxAmount,
			total: quote.total,
			linesAuthoredBy: { principalKind: 'USER', principalId: userId, recordedAt: f.createdAt }
		});
		f.reconciliation.balance = quote.total;
		history.versions.push(snapshot(f, f.version, 'QUOTE'));
	}
	const previous = /** @type {*} */ (request.depositRequirement);
	if (reviewed.depositChange) {
		request.depositRequirement = {
			state: 'ACTIVE',
			documentId: f.id,
			revision: previous.revision + 1,
			previousRevision: previous.revision,
			createdAt: stamp(),
			approvalDocumentVersion: f.version,
			terms: structuredClone(body.terms),
			requiredAmount: { amount: quote.deposit.requiredAmount.amount, currency: f.currency },
			satisfied: false
		};
		history.deposits.push(depositSnapshot(request.depositRequirement));
	}
	approve(request, planResolution, reviewedVersion, userId);
	request.servicePlan = request.effectiveServicePlan ?? null;
	const deposit = /** @type {*} */ (request.depositRequirement);
	request.proposal = {
		id: `${(request.proposalHistory.length + 3).toString(16)}${request.inquiry.id.slice(1)}`,
		inquiryId: request.inquiry.id,
		documentId: f.id,
		documentVersion: f.version,
		depositRequirementRevision: deposit.revision,
		issuedAt: stamp(),
		issuedBy: userId,
		issuanceKind: 'QUOTE_REVISED',
		...(request.servicePlan ? { servicePlanRevision: request.servicePlan.revision } : {})
	};
	request.proposalHistory.push(structuredClone(request.proposal));
	return {
		proposal: request.proposal,
		financial: request.financial,
		depositRequirement: request.depositRequirement,
		...(request.servicePlan ? { servicePlan: request.servicePlan } : {})
	};
}

/** @param {{quoteEpoch?: number}} session @param {Request} request @param {*} body */
export function previewInvoiceRevision(session, request, body) {
	try {
		if (
			!['BOOKED', 'SERVED'].includes(request.inquiry.lifecycle.stage) ||
			request.financial.stage !== 'INVOICE'
		)
			return refuse(409, 'illegal_transition');
		if (body?.expectedDocumentVersion !== request.financial.version) return refuse(409, 'conflict');
		if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 100)
			return refuse(422, 'validation_failed');
		let composed;
		try {
			composed = composeLines(request, body.lines);
		} catch {
			return refuse(422, 'validation_failed', ['LINE_NOT_IN_REVIEWED_DOCUMENT']);
		}
		if (composed.total < 0n) return refuse(422, 'validation_failed', ['NEGATIVE_DOCUMENT_TOTAL']);
		const plan = resolvePlan(request, body, composed.lines);
		if (!composed.financialChange && !plan.change)
			return refuse(422, 'validation_failed', ['NO_MATERIAL_CHANGE']);
		const current = request.effectiveServicePlan;
		const netApplied = request.financial.reconciliation.netApplied;
		const balance = composed.total - minor(netApplied);
		const reviewToken = createHash('sha256')
			.update(
				JSON.stringify({
					kind: 'invoice-revision',
					body,
					epoch: session.quoteEpoch ?? 0,
					plan: current?.revision ?? null,
					// Bound to immutable payment history, so even offsetting money changes go stale.
					payments: request.payments.map((h) => [
						h.payment.paymentId,
						h.reconciliation.netReceived,
						h.refunds.length
					])
				})
			)
			.digest('hex');
		return {
			status: 200,
			body: {
				inquiryId: request.inquiry.id,
				documentId: request.financial.id,
				reviewedDocumentVersion: request.financial.version,
				resultingDocumentVersion: request.financial.version + (composed.financialChange ? 1 : 0),
				currentTotal: request.financial.total,
				total: decimal(composed.total),
				subtotal: decimal(composed.lines.reduce((sum, l) => sum + minor(l.subtotal), 0n)),
				taxAmount: decimal(composed.lines.reduce((sum, l) => sum + minor(l.taxAmount), 0n)),
				currency: request.financial.currency,
				lines: composed.lines,
				financialChange: composed.financialChange,
				servicePlanChange: plan.change,
				...(current ? { currentServicePlanRevision: current.revision } : {}),
				...(current || plan.change
					? { resultingServicePlanRevision: (current?.revision ?? 0) + (plan.change ? 1 : 0) }
					: {}),
				...(plan.plan ? { servicePlan: plan.plan } : {}),
				netApplied,
				balance: decimal(balance),
				settlement: balance > 0n ? 'UNDERPAID' : balance === 0n ? 'SETTLED' : 'OVERPAID',
				reviewToken
			}
		};
	} catch (refusal) {
		if (refusal && typeof refusal === 'object' && 'status' in refusal)
			return /** @type {*} */ (refusal);
		throw refusal;
	}
}

/**
 * Approves a reviewed Invoice amendment. Payments, allocations, served status and the accepted
 * deposit are untouched; only the lines, balance and (optionally) the service approval move.
 * @param {Request} request @param {*} reviewed @param {*} body @param {string} userId
 */
export function applyInvoiceRevision(request, reviewed, body, userId) {
	const history = ensureHistory(request);
	const f = request.financial;
	const reviewedVersion = f.version;
	const planResolution = resolvePlan(request, body, reviewed.lines);
	if (reviewed.financialChange) {
		f.previousVersion = f.version;
		f.version = reviewed.resultingDocumentVersion;
		f.createdAt = stamp();
		f.lines = reviewed.lines.map((/** @type {*} */ { origin, key, ...line }) => {
			void origin;
			void key;
			return line;
		});
		Object.assign(f, {
			subtotal: reviewed.subtotal,
			taxAmount: reviewed.taxAmount,
			total: reviewed.total,
			linesAuthoredBy: { principalKind: 'USER', principalId: userId, recordedAt: f.createdAt }
		});
		f.reconciliation.balance = reviewed.balance;
		history.versions.push(snapshot(f, f.version, 'INVOICE'));
	}
	const approval = approve(request, planResolution, reviewedVersion, userId);
	return { financial: request.financial, ...(approval ? { servicePlan: approval } : {}) };
}

/**
 * Convenience for fixtures: previews and applies in one step, exactly as the endpoints would.
 * @param {Request} request @param {*} body
 */
export function reviseQuoteFixture(request, body) {
	const preview = previewQuoteRevision({}, request, body);
	if (preview.status !== 200) throw new Error(`Fixture quote revision refused: ${preview.status}`);
	applyQuoteRevision(request, preview.body, body, staffUserId);
	return request;
}
/** @param {Request} request @param {*} body */
export function amendInvoiceFixture(request, body) {
	const preview = previewInvoiceRevision({}, request, body);
	if (preview.status !== 200)
		throw new Error(`Fixture invoice amendment refused: ${preview.status}`);
	applyInvoiceRevision(request, preview.body, body, staffUserId);
	return request;
}
