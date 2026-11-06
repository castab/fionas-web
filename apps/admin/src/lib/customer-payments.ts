/**
 * Staff customer-payment access (fionas-commerce PR #36; its
 * `docs/stripe-payments-frontend-handoff.md` is the contract). Staff issue, copy, rotate and
 * revoke the stable `/pay/{publicId}` link and inspect provider attempts. Hand-maintained typed
 * transport and presentation; client-safe.
 *
 * The usable link is a bearer credential: workspace reads expose only its status and nonsecret
 * publicId; the URL is read only on a deliberate staff action and never stored in page data.
 */
import { isBusinessRevision } from './financial-revisions.js';
import type { InquiryStage } from './request-contract.js';

/** All three are required by commerce; the first is granted to no role automatically. */
export const PAYMENT_ACCESS_PERMISSIONS = [
	'fionas.payment-access.manage',
	'fionas.inquiries.read',
	'commerce.financial-document.read'
] as const;

export function hasPaymentAccessPermissions(permissions: string[]): boolean {
	return PAYMENT_ACCESS_PERMISSIONS.every((permission) => permissions.includes(permission));
}

/** Stages where a link can exist at all. REQUESTED and DECLINED never acquire one. */
export function customerPaymentsStage(stage: InquiryStage): boolean {
	return stage === 'QUOTED' || stage === 'BOOKED' || stage === 'SERVED' || stage === 'CLOSED';
}

/** Issuance and rotation: active bookings only. CLOSED may only retrieve and revoke. */
export function canIssuePaymentLink(stage: InquiryStage): boolean {
	return stage === 'QUOTED' || stage === 'BOOKED' || stage === 'SERVED';
}

export type PaymentLinkStatus =
	| { state: 'none' }
	| { state: 'active'; publicId: string }
	| { state: 'revoked'; publicId: string };

export type PaymentAttempt = {
	id: string;
	purpose: string;
	authorizedMinor: number;
	documentVersion: number;
	businessRevision: number;
	state: string;
	outcome: string;
	createdAt: string;
	expiresAt: string;
	sessionId?: string;
	paymentIntentId?: string;
	ledgerPaymentId?: string;
	diagnostic?: string;
};

export type CustomerPaymentsView =
	| { availability: 'ready'; link: PaymentLinkStatus; attempts: PaymentAttempt[] | null }
	| { availability: 'disabled' | 'forbidden' | 'unavailable' };

export type PaymentLinkIntent = 'issue' | 'reveal' | 'rotate' | 'revoke' | 'reconcile';

/** What a customer-payments action returns. `url` is present only for a deliberate reveal. */
export type CustomerPaymentsResult = {
	intent: PaymentLinkIntent;
	link?: PaymentLinkStatus;
	attempts?: PaymentAttempt[] | null;
	url?: string;
	reconciled?: { attemptId: string; state: string; outcome: string };
	message?: string;
	/** How `message` reads: confirmed release/payment, plain status, or something needing care. */
	messageTone?: 'positive' | 'neutral' | 'warning';
	/** A reconcile may have changed settlement: Right now and Activity should be re-read. */
	settlement?: boolean;
	error?: string;
	/** The mutation may have committed: controls stay blocked until a reload confirms state. */
	reviewRequired?: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENUM = /^[A-Z][A-Z_]{0,63}$/;
const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const optionalText = (value: unknown, max = 255) =>
	value === undefined || value === null || (typeof value === 'string' && value.length <= max);

/** Link status from `PaymentAccessResponse`, never its URL. Null when malformed. */
export function readLinkStatus(value: unknown): PaymentLinkStatus | null {
	if (!isObject(value) || typeof value.revoked !== 'boolean') return null;
	const { publicId, revoked } = value;
	if (publicId === undefined || publicId === null) return revoked ? null : { state: 'none' };
	if (typeof publicId !== 'string' || !UUID.test(publicId)) return null;
	return revoked ? { state: 'revoked', publicId } : { state: 'active', publicId };
}

/**
 * The usable customer URL for an active link: `…/pay/{publicId}#<43-character secret>` on an
 * http(s) origin, exactly. Anything else is refused rather than offered for copying.
 */
export function readPaymentLinkUrl(value: unknown): string | null {
	const status = readLinkStatus(value);
	if (status?.state !== 'active' || !isObject(value) || typeof value.url !== 'string') return null;
	try {
		const url = new URL(value.url);
		return ['https:', 'http:'].includes(url.protocol) &&
			!url.username &&
			!url.password &&
			!url.search &&
			url.pathname === `/pay/${status.publicId}` &&
			/^#[A-Za-z0-9_-]{43}$/.test(url.hash)
			? url.href
			: null;
	} catch {
		return null;
	}
}

function readAttempt(value: unknown): PaymentAttempt | null {
	if (!isObject(value)) return null;
	const v = value;
	if (
		typeof v.id !== 'string' ||
		!UUID.test(v.id) ||
		typeof v.purpose !== 'string' ||
		!ENUM.test(v.purpose) ||
		!Number.isSafeInteger(v.authorizedMinor) ||
		!Number.isSafeInteger(v.documentVersion) ||
		!isBusinessRevision(v.businessRevision) ||
		typeof v.state !== 'string' ||
		!ENUM.test(v.state) ||
		typeof v.outcome !== 'string' ||
		!ENUM.test(v.outcome) ||
		typeof v.createdAt !== 'string' ||
		!Number.isFinite(Date.parse(v.createdAt)) ||
		typeof v.expiresAt !== 'string' ||
		!Number.isFinite(Date.parse(v.expiresAt)) ||
		!optionalText(v.sessionId) ||
		!optionalText(v.paymentIntentId) ||
		!(
			v.ledgerPaymentId === undefined ||
			v.ledgerPaymentId === null ||
			(typeof v.ledgerPaymentId === 'string' && UUID.test(v.ledgerPaymentId))
		) ||
		!optionalText(v.diagnostic, 500)
	)
		return null;
	const optional = (key: 'sessionId' | 'paymentIntentId' | 'ledgerPaymentId' | 'diagnostic') =>
		typeof v[key] === 'string' ? { [key]: v[key] as string } : {};
	return {
		id: v.id,
		purpose: v.purpose,
		authorizedMinor: v.authorizedMinor as number,
		documentVersion: v.documentVersion as number,
		businessRevision: v.businessRevision,
		state: v.state,
		outcome: v.outcome,
		createdAt: v.createdAt,
		expiresAt: v.expiresAt,
		...optional('sessionId'),
		...optional('paymentIntentId'),
		...optional('ledgerPaymentId'),
		...optional('diagnostic')
	};
}

/** `StripeAttemptsResponse` items, or null when any item is malformed. */
export function readPaymentAttempts(value: unknown): PaymentAttempt[] | null {
	if (!isObject(value) || !Array.isArray(value.items) || value.items.length > 200) return null;
	const items = value.items.map(readAttempt);
	return items.every((item) => item !== null) ? (items as PaymentAttempt[]) : null;
}

/** `CheckoutResponse` from a staff reconcile: state and outcome only (any URL is dropped). */
export function readReconcileResult(
	value: unknown
): { attemptId: string; state: string; outcome: string } | null {
	if (!isObject(value)) return null;
	const { attemptId, state, outcome } = value;
	return typeof attemptId === 'string' &&
		UUID.test(attemptId) &&
		typeof state === 'string' &&
		ENUM.test(state) &&
		typeof outcome === 'string' &&
		ENUM.test(outcome)
		? { attemptId, state, outcome }
		: null;
}

/** Presentation of an attempt for staff. Attempts are provider diagnostics, never ledger facts. */
export const attemptStateLabels: Record<string, string> = {
	CREATING: 'Creating',
	OPEN: 'Checkout open',
	PROCESSING: 'Processing',
	EXPIRED: 'Expired',
	FAILED: 'Failed',
	SUCCEEDED: 'Paid at Stripe'
};

export const attemptOutcomeLabels: Record<string, string> = {
	PENDING: 'Not applied yet',
	APPLIED: 'Applied to the booking',
	RECONCILIATION_REQUIRED: 'Needs staff reconciliation'
};

export function attemptPurposeLabel(purpose: string): string {
	return purpose === 'DEPOSIT' ? 'Deposit' : purpose === 'INVOICE' ? 'Invoice payment' : purpose;
}

/** Attempts a staff check could still change: active ones, or paid but not yet applied. */
export function canReconcileAttempt(attempt: PaymentAttempt): boolean {
	// Only coherent unresolved pairs (see `coherentAttempt`): an incoherent one is investigated.
	return (
		attempt.outcome === 'PENDING' &&
		!attempt.ledgerPaymentId &&
		['CREATING', 'OPEN', 'PROCESSING', 'SUCCEEDED'].includes(attempt.state)
	);
}

/** Exact cents to "$1,234.56"; integer arithmetic only. */
export function formatMinor(minor: number): string {
	const cents = BigInt(minor);
	const negative = cents < 0n;
	const absolute = negative ? -cents : cents;
	const whole = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	return `${negative ? '-' : ''}$${whole}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

/** Safe staff copy for a failed customer-payments call. Never backend message text. */
export function customerPaymentsErrorMessage(
	intent: PaymentLinkIntent,
	status: number,
	code?: string
): string {
	if (status === 403) return "You don't have permission to manage customer payment links.";
	if (status === 503 && code === 'stripe_disabled')
		return 'Online payments are turned off in commerce, so payment links are unavailable.';
	if (status === 404)
		return intent === 'reconcile'
			? 'That payment attempt was not found for this request.'
			: 'This request has no payment link to change.';
	if (status === 409)
		return intent === 'reconcile'
			? "We couldn't reconcile this checkout, and no release was confirmed. Reload to check its latest status before doing anything else with it."
			: intent === 'issue' || intent === 'rotate'
				? 'Payment links can be created or rotated only while a request is quoted, booked or served.'
				: 'The payment link changed. Reload to see its current status.';
	if (status === 400 || status === 422) return 'That request was refused. Reload and try again.';
	return intent === 'reveal'
		? "We couldn't load the payment link. Try again in a moment."
		: intent === 'reconcile'
			? "We couldn't confirm what Stripe did. Don't assume the checkout was released or paid: reload to see the current status before another action."
			: "We couldn't confirm the result. Reload to see the current status before trying again.";
}
