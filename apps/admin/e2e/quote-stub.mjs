// Synthetic test ledger only; no menu or production pricing authority.
import { createHash } from 'node:crypto';
import { proposalPair, resolveDepositAmount } from './request-fixture.mjs';
/** @param {string} value */
export const units = (value) => {
	const negative = value.startsWith('-');
	const [whole, fraction = ''] = value.replace('-', '').split('.');
	const n = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
	return negative ? -n : n;
};
/** @param {bigint} amount */
export const decimal = (amount) => {
	const negative = amount < 0n;
	const n = negative ? -amount : amount;
	return `${negative ? '-' : ''}${n / 100n}.${(n % 100n).toString().padStart(2, '0')}`;
};
/** @param {string} value */
export const minor = (value) => {
	const n = units(value);
	if (n % 10n ** 16n !== 0n) throw new Error('Nonsettleable');
	return n / 10n ** 16n;
};
/** Commerce's canonical ServicePlanItem (PR #28): trimmed text, blank metadata as null.
 * @param {unknown} item */
export const selection = (item) => {
	if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Legacy item');
	const {
		label,
		group = null,
		key = null,
		...rest
	} = /** @type {Record<string, unknown>} */ (item);
	/** @param {unknown} v @param {number} max */
	const text = (v, max) => typeof v === 'string' && !!v && v === v.trim() && v.length <= max;
	if (
		Object.keys(rest).length ||
		!text(label, 200) ||
		(group !== null && !text(group, 120)) ||
		(key !== null && !text(key, 120))
	)
		throw new Error('Malformed item');
	return { label, group, key };
};
/**
 * Resolves proposed lines against the reviewed document the way the backend does: existing ids carry
 * or replace, keys derive a new id, omission removes. Throws on anything the backend rejects.
 * @param {import('../src/lib/request-contract.js').CurrentStaffRequest} request
 * @param {import('../src/lib/quote-contract.js').ProposedLine[]} proposed */
export function composeLines(request, proposed) {
	const identities = new Set();
	let total = 0n;
	const lines = proposed.map((l) => {
		if (!!l.lineItemId === !!l.key || !l.description || l.currency !== request.financial.currency)
			throw new Error('Malformed line');
		const existing = l.lineItemId
			? request.financial.lines.find((x) => x.id === l.lineItemId)
			: null;
		if (l.lineItemId && !existing) throw new Error('Unknown line');
		const id =
			l.lineItemId ??
			`${createHash('sha256')
				.update(request.financial.id + ':' + request.financial.version + ':' + l.key)
				.digest('hex')
				.substring(0, 8)}-0000-4000-8000-000000000000`;
		if (identities.has(id)) throw new Error('Duplicate');
		identities.add(id);
		const ext = l.quantity
			? (units(l.unitPrice) * units(l.quantity)) / 10n ** 18n
			: units(l.unitPrice);
		if (ext % 10n ** 16n !== 0n) throw new Error('Nonsettleable');
		const subtotal = ext / 10n ** 16n;
		const tax = minor(l.taxAmount);
		total += subtotal + tax;
		const equal =
			existing &&
			/** @type {const} */ (['description', 'subDescription', 'currency']).every(
				(k) => (existing[k] ?? null) === (l[k] ?? null)
			) &&
			units(existing.unitPrice) === units(l.unitPrice) &&
			units(existing.taxAmount) === units(l.taxAmount) &&
			(existing.quantity == null
				? l.quantity == null
				: l.quantity != null && units(existing.quantity) === units(l.quantity));
		const { lineItemId, ...values } = l;
		void lineItemId;
		return {
			...values,
			id,
			origin: /** @type {'CARRIED' | 'REPLACED' | 'NEW'} */ (
				existing ? (equal ? 'CARRIED' : 'REPLACED') : 'NEW'
			),
			subtotal: decimal(subtotal),
			total: decimal(subtotal + tax)
		};
	});
	const financialChange =
		lines.length !== request.financial.lines.length ||
		lines.some((l, i) => l.id !== request.financial.lines[i]?.id || l.origin !== 'CARRIED');
	return { lines, total, financialChange };
}
/** The plan as the preview and ledger carry it: canonical items, notes joined to final line ids.
 * @param {import('../src/lib/quote-contract.js').ServicePlanRequest} plan
 * @param {{id: string, key?: string}[]} lines */
export function composePlan(plan, lines) {
	const items = plan.items ?? [];
	if (!Array.isArray(items) || items.length > 50) throw new Error('Too many items');
	return {
		...plan,
		items: items.map(selection),
		lineNotes: (plan.lineNotes ?? []).map((n) => {
			const line = lines.find((l) => (n.lineItemId ? l.id === n.lineItemId : l.key === n.key));
			if (!line) throw new Error('Plan identity missing');
			return { lineItemId: line.id, note: n.note };
		})
	};
}
/** @param {{quoteEpoch?:number}} session
 * @param {import('../src/lib/request-contract.js').CurrentStaffRequest} request
 * @param {import('../src/lib/quote-contract.js').PreviewInquiryQuoteRequest} body */
export function previewQuote(session, request, body) {
	if (body?.expectedDocumentVersion !== request.financial.version)
		return { status: 409, body: { code: 'conflict' } };
	if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 100)
		return { status: 422, body: { code: 'validation_failed' } };
	try {
		const { lines, total, financialChange } = composeLines(request, body.lines);
		if (total <= 0n) throw new Error('Quote must be positive');
		const servicePlan = body.servicePlan ? composePlan(body.servicePlan, lines) : undefined;
		const amount = decimal(total);
		const reviewToken = createHash('sha256')
			.update(
				JSON.stringify({
					expectedDocumentVersion: body.expectedDocumentVersion,
					lines: body.lines,
					servicePlan: body.servicePlan,
					terms: body.terms,
					epoch: session.quoteEpoch ?? 0
				})
			)
			.digest('hex');
		return {
			status: 200,
			body: {
				inquiryId: request.inquiry.id,
				documentId: request.financial.id,
				reviewedDocumentVersion: request.financial.version,
				estimateTotal: request.financial.total,
				financialChange,
				quoteVersion: request.financial.version + (financialChange ? 2 : 1),
				lines,
				subtotal: decimal(lines.reduce((sum, l) => sum + minor(l.subtotal), 0n)),
				taxAmount: decimal(lines.reduce((sum, l) => sum + minor(l.taxAmount), 0n)),
				total: amount,
				currency: request.financial.currency,
				deposit: {
					terms: body.terms,
					requiredAmount: {
						amount: resolveDepositAmount(amount, body.terms, request.financial.currency),
						currency: request.financial.currency
					}
				},
				servicePlan,
				reviewToken
			}
		};
	} catch {
		return {
			status: 422,
			body: { code: 'validation_failed', violations: [{ code: 'LINE_NOT_IN_REVIEWED_DOCUMENT' }] }
		};
	}
}
/** @param {import('../src/lib/request-contract.js').CurrentStaffRequest} request
 * @param {import('../src/lib/quote-contract.js').InquiryQuotePreviewResponse} preview
 * @param {import('../src/lib/request-contract.js').DepositTermsRequest} terms
 * @param {string} userId */
export function issueComposedQuote(request, preview, terms, userId) {
	request.financial.previousVersion = request.financial.version;
	request.financial.version = preview.quoteVersion;
	request.financial.stage = 'QUOTE';
	request.financial.lines = preview.lines.map(({ origin, key, ...line }) => {
		void origin;
		void key;
		return line;
	});
	Object.assign(request.financial, {
		subtotal: preview.subtotal,
		taxAmount: preview.taxAmount,
		total: preview.total,
		linesAuthoredBy: {
			principalKind: 'USER',
			principalId: userId,
			recordedAt: '2026-07-16T19:01:00Z'
		}
	});
	request.financial.reconciliation.balance = preview.total;
	request.inquiry.lifecycle.stage = 'QUOTED';
	Object.assign(
		request,
		proposalPair(
			request.inquiry.id,
			request.financial.id,
			preview.quoteVersion,
			preview.total,
			terms,
			preview.currency
		)
	);
	request.servicePlanHistory = [];
	request.effectiveServicePlan = null;
	request.servicePlan = null;
	request.acceptedServicePlan = null;
	if (preview.servicePlan) {
		request.servicePlan = {
			...preview.servicePlan,
			documentId: request.financial.id,
			documentVersion: preview.quoteVersion,
			reviewedDocumentVersion: preview.reviewedDocumentVersion,
			approvedAt: '2026-07-16T19:01:00Z',
			approvedBy: userId,
			revision: 1,
			cleared: false
		};
		request.servicePlanHistory = [request.servicePlan];
		request.effectiveServicePlan = request.servicePlan;
		request.proposal = /** @type {*} */ ({ ...request.proposal, servicePlanRevision: 1 });
	}
	request.proposalHistory = [structuredClone(/** @type {*} */ (request.proposal))];
}
