/**
 * What the customer can do now, derived only from the authoritative summary. Anything unknown or
 * incoherent fails closed to `unavailable`: no state here can be reached by guessing, and no
 * payment control is ever enabled by a value the page does not recognize.
 */
import type { CustomerPaymentSummary } from './contract.js';
import { decimalToCents, STRIPE_MAX_CENTS, STRIPE_MIN_CENTS } from './money.js';

/** Payable terms the customer reviewed: exactly what a checkout command may carry. */
export type PayableTerms =
	| { purpose: 'DEPOSIT'; amountCents: bigint; documentVersion: number; businessRevision: number }
	| {
			purpose: 'INVOICE';
			/** The complete outstanding Invoice balance. */
			amountCents: bigint;
			/** Whether the whole balance fits one Stripe payment; otherwise a partial is required. */
			fullAllowed: boolean;
			documentVersion: number;
			businessRevision: number;
	  };

export type PaymentView =
	| { kind: 'deposit-due'; terms: PayableTerms & { purpose: 'DEPOSIT' } }
	| { kind: 'balance-due'; terms: PayableTerms & { purpose: 'INVOICE' } }
	/** Another payment may be underway; `recovery` terms exist only when a check is offered. */
	| { kind: 'in-progress'; recovery: PayableTerms | null }
	| { kind: 'reconciliation' }
	| { kind: 'no-balance'; creditCents: bigint | null }
	| { kind: 'closed' }
	| { kind: 'staff-assist'; reason: 'below-minimum' | 'above-maximum' }
	| { kind: 'not-ready' }
	| { kind: 'unavailable' };

const ACTIVE = ['QUOTED', 'BOOKED', 'SERVED'];

/**
 * The coherent payable terms in this summary, ignoring only whether another payment is underway.
 * Null unless the lifecycle, mode, document stage, currency, versions and amount all agree.
 */
export function payableTerms(summary: CustomerPaymentSummary): PayableTerms | null {
	const { lifecycle, mode, document } = summary;
	const required = decimalToCents(summary.requiredAmount);
	if (
		required === null ||
		required < STRIPE_MIN_CENTS ||
		document.currency !== 'USD' ||
		document.version < 1 ||
		document.businessRevision < 1
	)
		return null;
	const versions = {
		documentVersion: document.version,
		businessRevision: document.businessRevision
	};
	if (lifecycle === 'QUOTED' && mode === 'DEPOSIT' && document.stage === 'QUOTE')
		return required > STRIPE_MAX_CENTS
			? null
			: { purpose: 'DEPOSIT', amountCents: required, ...versions };
	if (
		(lifecycle === 'BOOKED' || lifecycle === 'SERVED') &&
		mode === 'INVOICE' &&
		document.stage === 'INVOICE'
	)
		return {
			purpose: 'INVOICE',
			amountCents: required,
			fullAllowed: required <= STRIPE_MAX_CENTS,
			...versions
		};
	return null;
}

export function paymentView(summary: CustomerPaymentSummary): PaymentView {
	const { lifecycle } = summary;
	if (lifecycle === 'CLOSED') return { kind: 'closed' };
	if (!ACTIVE.includes(lifecycle)) return { kind: 'unavailable' };
	if (summary.reconciliationPending) return { kind: 'reconciliation' };
	if (summary.paymentInProgress)
		return {
			kind: 'in-progress',
			recovery: summary.checkoutRecoveryAvailable ? payableTerms(summary) : null
		};
	if (!summary.canPay) {
		switch (summary.unavailableReason) {
			case 'NO_PAYMENT_DUE': {
				const balance = decimalToCents(summary.balance);
				return {
					kind: 'no-balance',
					creditCents: balance !== null && balance < 0n ? -balance : null
				};
			}
			case 'BELOW_STRIPE_MINIMUM':
				return { kind: 'staff-assist', reason: 'below-minimum' };
			case 'ABOVE_STRIPE_MAXIMUM':
				return { kind: 'staff-assist', reason: 'above-maximum' };
			case 'NOT_PUBLISHED':
				return { kind: 'not-ready' };
			case 'CLOSED':
				return { kind: 'closed' };
			case 'RECONCILIATION_PENDING':
				return { kind: 'reconciliation' };
			case 'PAYMENT_IN_PROGRESS':
				return { kind: 'in-progress', recovery: null };
			default:
				// UNSUPPORTED_CURRENCY, a missing reason, or one this page does not know.
				return { kind: 'unavailable' };
		}
	}
	// canPay with a reason is incoherent.
	if (summary.unavailableReason !== undefined) return { kind: 'unavailable' };
	const terms = payableTerms(summary);
	if (!terms) {
		const required = decimalToCents(summary.requiredAmount);
		return required !== null && required > 0n && required < STRIPE_MIN_CENTS
			? { kind: 'staff-assist', reason: 'below-minimum' }
			: { kind: 'unavailable' };
	}
	return terms.purpose === 'DEPOSIT'
		? { kind: 'deposit-due', terms }
		: { kind: 'balance-due', terms };
}

/**
 * "Quote" / "Invoice". Customers never see generated version labels: the ledger version and the
 * business revision stay internal, used only for checkout concurrency (`payableTerms`).
 */
export function documentLabel(summary: CustomerPaymentSummary): string | null {
	const { stage, businessRevision } = summary.document;
	const name = stage === 'QUOTE' ? 'Quote' : stage === 'INVOICE' ? 'Invoice' : null;
	return name && businessRevision >= 1 ? name : null;
}

/** The booking-stage label for the page header. */
export function stageLabel(summary: CustomerPaymentSummary): string {
	switch (summary.lifecycle) {
		case 'QUOTED':
			return 'Quote ready';
		case 'BOOKED':
			return 'Booked';
		case 'SERVED':
			return 'Event served';
		case 'CLOSED':
			return 'Closed';
		default:
			return 'Booking';
	}
}

/** A date-only event date ("Saturday, May 1, 2027"), with no timezone shift. */
export function eventDateLabel(eventDate: string): string {
	const [year, month, day] = eventDate.split('-').map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	if (!Number.isFinite(date.getTime())) return eventDate;
	return new Intl.DateTimeFormat('en-US', {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'UTC'
	}).format(date);
}

/** A receipt's date in Fiona's business timezone ("May 1, 2027"). */
export function receivedDateLabel(receivedAt: string): string {
	return new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'America/Los_Angeles'
	}).format(new Date(receivedAt));
}

/** Whole-percent paid of total for a progress bar: presentation only, never a financial fact. */
export function paidPercent(summary: CustomerPaymentSummary): number | null {
	const total = decimalToCents(summary.document.totalAmount);
	const paid = decimalToCents(summary.paidAmount);
	if (total === null || paid === null || total <= 0n) return null;
	if (paid <= 0n) return 0;
	if (paid >= total) return 100;
	return Number((paid * 100n) / total);
}
