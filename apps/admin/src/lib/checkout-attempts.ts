/**
 * Staff-only presentation of Stripe Checkout attempts against the current booking terms
 * (fionas-commerce PR #41). Pure and client-safe.
 *
 * This is never an authorization decision. Commerce's own `termsMatch` (purpose, document,
 * ledger version, business revision, proposal, deposit revision, amount and collectibility)
 * decides whether reconciliation expires a session; the admin only decides which control to
 * offer. An OPEN attempt is called superseded only when a field the attempt DTO exposes
 * demonstrably differs from the authoritative staff request. When a comparison is impossible
 * (missing revision, unknown purpose, a document that can't be paid online) the attempt is
 * `open_unverified` and gets a general status check, never a release claim.
 */
import type { PaymentAttempt } from './customer-payments.js';
import type { CurrentStaffRequest } from './request-contract.js';

export type AttemptStatus =
	/** OPEN, and every comparable field matches the current terms. */
	| 'open_current'
	/** OPEN, authorized against terms the staff request shows are no longer current. */
	| 'open_superseded'
	/** OPEN, but the current terms can't be compared from here. */
	| 'open_unverified'
	/** Commerce has not confirmed a Stripe session yet. */
	| 'creating'
	/** Stripe is confirming a payment. */
	| 'processing'
	/** Paid at Stripe; commerce hasn't applied it yet. */
	| 'paid_pending'
	| 'applied'
	/** Money reached the ledger but needs staff allocation. Never "cancelled" or "lost". */
	| 'reconciliation_required'
	/** Provider-confirmed release. */
	| 'expired'
	| 'failed'
	/** A state or outcome this admin doesn't know. */
	| 'unrecognized';

/** Why an OPEN attempt is superseded, for staff copy. */
export type SupersededReason = 'purpose' | 'document' | 'revision' | 'amount';

/** The terms a new checkout would be authorized against, as far as the staff request shows. */
export type CurrentPaymentTerms = {
	purpose: 'DEPOSIT' | 'INVOICE';
	documentVersion: number;
	/** Null when commerce did not report the current business revision. */
	businessRevision: number | null;
	/** DEPOSIT: the exact required deposit; INVOICE: the authoritative balance. Decimal strings. */
	amount: string | null;
};

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
const revision = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/**
 * Exact comparison of whole cents with a decimal string: -1, 0 or 1, or null when the decimal is
 * malformed. Integer arithmetic only; nothing is rounded.
 */
export function compareMinor(minor: number, decimal: string): -1 | 0 | 1 | null {
	const match = DECIMAL.exec(decimal);
	if (!match || !Number.isSafeInteger(minor)) return null;
	const [, sign, whole, fraction = ''] = match;
	const scale = 10n ** BigInt(fraction.length);
	const value = BigInt(whole + fraction) * (sign ? -1n : 1n);
	const left = BigInt(minor) * scale;
	const right = value * 100n;
	return left < right ? -1 : left > right ? 1 : 0;
}

/** The current document's payment terms, or null when no online payment can apply to it. */
export function currentPaymentTerms(
	request: CurrentStaffRequest | null | undefined
): CurrentPaymentTerms | null {
	if (!request) return null;
	const { financial, depositRequirement: deposit } = request;
	if (financial.stage === 'QUOTE')
		return {
			purpose: 'DEPOSIT',
			documentVersion: financial.version,
			businessRevision: revision(request.currentQuoteRevision)
				? request.currentQuoteRevision
				: null,
			amount: deposit.state === 'ACTIVE' ? deposit.requiredAmount.amount : null
		};
	if (financial.stage === 'INVOICE')
		return {
			purpose: 'INVOICE',
			documentVersion: financial.version,
			businessRevision: revision(request.currentInvoiceRevision)
				? request.currentInvoiceRevision
				: null,
			amount: financial.reconciliation.balance
		};
	return null;
}

export type AttemptClassification = { status: AttemptStatus; reasons: SupersededReason[] };

function classifyOpen(
	attempt: PaymentAttempt,
	terms: CurrentPaymentTerms | null
): AttemptClassification {
	if (!terms || (attempt.purpose !== 'DEPOSIT' && attempt.purpose !== 'INVOICE'))
		return { status: 'open_unverified', reasons: [] };
	// A different purpose (a deposit checkout after booking) settles it: nothing else compares.
	if (attempt.purpose !== terms.purpose) return { status: 'open_superseded', reasons: ['purpose'] };
	const reasons: SupersededReason[] = [];
	let comparable = true;
	if (attempt.documentVersion !== terms.documentVersion) reasons.push('document');
	if (terms.businessRevision === null) comparable = false;
	else if (attempt.businessRevision !== terms.businessRevision) reasons.push('revision');
	const amount = terms.amount === null ? null : compareMinor(attempt.authorizedMinor, terms.amount);
	if (amount === null) comparable = false;
	// A deposit authorizes exactly the required deposit; an Invoice payment at most the balance.
	else if (terms.purpose === 'DEPOSIT' ? amount !== 0 : amount > 0) reasons.push('amount');
	if (reasons.length) return { status: 'open_superseded', reasons };
	return { status: comparable ? 'open_current' : 'open_unverified', reasons: [] };
}

/** One attempt's presentation status. Attempts are provider diagnostics, never ledger facts. */
export function classifyAttempt(
	attempt: PaymentAttempt,
	terms: CurrentPaymentTerms | null
): AttemptClassification {
	const none = (status: AttemptStatus): AttemptClassification => ({ status, reasons: [] });
	// Money at Stripe or in the ledger outranks every checkout state.
	if (attempt.outcome === 'RECONCILIATION_REQUIRED') return none('reconciliation_required');
	if (attempt.outcome === 'APPLIED') return none('applied');
	if (attempt.outcome !== 'PENDING') return none('unrecognized');
	switch (attempt.state) {
		case 'OPEN':
			return classifyOpen(attempt, terms);
		case 'CREATING':
			return none('creating');
		case 'PROCESSING':
			return none('processing');
		case 'SUCCEEDED':
			return none('paid_pending');
		case 'EXPIRED':
			return none('expired');
		case 'FAILED':
			return none('failed');
		default:
			return none('unrecognized');
	}
}

/**
 * Attempts that need a staff decision in the card's main area, newest first: superseded open
 * checkouts (Release previous checkout), payments being confirmed, and unconfirmed checkouts
 * (Check payment status). A current open checkout, settled and released attempts stay in the
 * diagnostics list; RECONCILIATION_REQUIRED keeps its own card-level warning.
 */
export type AttemptAttention = {
	attempt: PaymentAttempt;
	kind: 'release' | 'confirming' | 'unconfirmed';
	status: AttemptStatus;
	reasons: SupersededReason[];
};

export function attemptsNeedingAttention(
	attempts: readonly PaymentAttempt[] | null,
	terms: CurrentPaymentTerms | null
): AttemptAttention[] {
	const result: AttemptAttention[] = [];
	for (const attempt of attempts ?? []) {
		const { status, reasons } = classifyAttempt(attempt, terms);
		const kind =
			status === 'open_superseded'
				? 'release'
				: status === 'processing' || status === 'paid_pending'
					? 'confirming'
					: status === 'creating' || status === 'open_unverified'
						? 'unconfirmed'
						: null;
		if (kind) result.push({ attempt, kind, status, reasons });
	}
	return result.sort((a, b) => Date.parse(b.attempt.createdAt) - Date.parse(a.attempt.createdAt));
}

/** Staff-only label for the terms an attempt was authorized against ("Quote v2"). */
export const attemptDocumentLabel = (attempt: PaymentAttempt) =>
	`${attempt.purpose === 'DEPOSIT' ? 'Quote' : attempt.purpose === 'INVOICE' ? 'Invoice' : 'Document'} v${attempt.businessRevision}`;

/** Staff-only label for the current terms ("Quote v3"), or null without a business revision. */
export const termsDocumentLabel = (terms: CurrentPaymentTerms | null) =>
	terms?.businessRevision
		? `${terms.purpose === 'DEPOSIT' ? 'Quote' : 'Invoice'} v${terms.businessRevision}`
		: null;

/** One sentence on what changed, from the reasons the comparison could prove. */
export function supersededCopy(
	attempt: PaymentAttempt,
	reasons: readonly SupersededReason[],
	terms: CurrentPaymentTerms | null
): string {
	if (reasons.includes('purpose'))
		return attempt.purpose === 'DEPOSIT'
			? 'It was started for the Quote deposit, but the booking now has an Invoice.'
			: 'It was started for a different payment than the booking now needs.';
	const current = termsDocumentLabel(terms);
	const authorized = attemptDocumentLabel(attempt);
	if ((reasons.includes('revision') || reasons.includes('document')) && current)
		return `It was started for ${authorized}; the current terms are ${current}.`;
	if (reasons.includes('revision') || reasons.includes('document'))
		return `It was started for ${authorized}, which is no longer the current version.`;
	return attempt.purpose === 'DEPOSIT'
		? 'Its amount no longer matches the deposit required now.'
		: 'Its amount is more than the balance due now.';
}

export type ReconcileTone = 'positive' | 'neutral' | 'warning';

/**
 * Staff feedback for a validated reconcile answer. Only EXPIRED and FAILED are provider-confirmed
 * releases; nothing else says released, and EXPIRED never promises the booking is payable.
 */
export function reconcileFeedback(result: { state: string; outcome: string }): {
	text: string;
	tone: ReconcileTone;
	/** Settlement may have changed: re-read Right now and Activity. */
	settlement: boolean;
	unconfirmed?: true;
} {
	if (result.outcome === 'RECONCILIATION_REQUIRED')
		return {
			text: 'Stripe received this payment, but it needs staff reconciliation before it counts toward the booking. Review unapplied payments; don’t collect it again.',
			tone: 'warning',
			settlement: true
		};
	if (result.outcome === 'APPLIED')
		return {
			text: 'Stripe confirmed the payment, and it’s applied to this booking. Right now shows the updated balance.',
			tone: 'positive',
			settlement: true
		};
	if (result.outcome !== 'PENDING') return unconfirmedFeedback;
	switch (result.state) {
		case 'EXPIRED':
			return {
				text: 'Stripe confirmed the previous checkout expired, so it’s released. The customer can start a new payment from the same link if the current terms allow it.',
				tone: 'positive',
				settlement: false
			};
		case 'FAILED':
			return {
				text: 'Stripe reports this attempt failed, so nothing was collected by it. Review the current payment status before your next step.',
				tone: 'neutral',
				settlement: false
			};
		case 'OPEN':
			return {
				text: 'Stripe shows this checkout is still open, so it wasn’t released. Commerce releases a checkout only when its terms are out of date or the link is revoked.',
				tone: 'neutral',
				settlement: false
			};
		case 'CREATING':
			return {
				text: 'Stripe hasn’t confirmed this checkout yet. Check its status again shortly.',
				tone: 'neutral',
				settlement: false
			};
		case 'PROCESSING':
			return {
				text: 'Stripe is confirming a payment for this checkout. Don’t start or record another payment; check again later.',
				tone: 'warning',
				settlement: false
			};
		case 'SUCCEEDED':
			return {
				text: 'Stripe reports the payment succeeded, but it isn’t applied to the booking yet. Check again shortly.',
				tone: 'warning',
				settlement: true
			};
		default:
			return unconfirmedFeedback;
	}
}

/** An answer this admin can't interpret: the card blocks until an authoritative reload. */
const unconfirmedFeedback = {
	text: 'We couldn’t confirm the result. Reload to review the current status before another action.',
	tone: 'warning' as const,
	settlement: true,
	unconfirmed: true as const
};
