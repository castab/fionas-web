/**
 * The customer payment contract with fionas-commerce (`readCustomerPaymentSummary`,
 * `createCustomerCheckoutSession`; see its `docs/stripe-payments-frontend-handoff.md` and
 * OpenAPI). Hand-maintained typed transport: the readers below whitelist the fields the page uses
 * and refuse anything malformed, so an unexpected response can never enable a payment.
 *
 * Client-safe: the public BFF and the browser both validate with these.
 */
import { decimalToCents } from './money.js';

export type PaymentReceipt = {
	amount: string;
	refundedAmount: string;
	receivedAt: string;
};

export type PaymentDocument = {
	id: string;
	/** Immutable ledger version, used only for concurrency. Never a customer-facing label. */
	version: number;
	stage: string;
	/** The customer-facing Quote/Invoice revision ("Quote v4"). */
	businessRevision: number;
	acceptedQuoteRevision?: number;
	currency: string;
	totalAmount: string;
};

export type CustomerPaymentSummary = {
	inquiryId: string;
	eventDate: string;
	lifecycle: string;
	document: PaymentDocument;
	mode: string;
	requiredAmount: string;
	paidAmount: string;
	balance: string;
	canPay: boolean;
	unavailableReason?: string;
	paymentInProgress: boolean;
	reconciliationPending: boolean;
	/** Optional in the contract; absent means false. */
	checkoutRecoveryAvailable: boolean;
	history: PaymentReceipt[];
};

/** The only body the browser may post. Totals, currency, purpose and terms belong to commerce. */
export type CheckoutCommand = {
	expectedDocumentVersion: number;
	expectedBusinessRevision: number;
	/** A partial Invoice payment in integer cents. Omitted for a deposit or a whole balance. */
	amountMinor?: number;
};

export type CheckoutResponse = {
	attemptId: string;
	url?: string;
	state: string;
	outcome: string;
};

export type PaymentError = { code: string; message?: string };

/** Conflict messages the UI acts on; any other message text is never forwarded or shown. */
export const CONFLICT_MESSAGES = [
	'PAYMENT_TERMS_CHANGED',
	'CHECKOUT_KEY_REUSED',
	'RECONCILIATION_PENDING'
] as const;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The bearer commerce issues: 32 random bytes, base64url without padding. */
export const PAYMENT_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const ENUM = /^[A-Z][A-Z_]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_INT = 2_147_483_647;
const MAX_HISTORY = 500;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isEnum = (value: unknown): value is string => typeof value === 'string' && ENUM.test(value);
const isCount = (value: unknown, min: number): value is number =>
	Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= MAX_INT;
/** Exact decimal strings that are whole USD cents (the page never renders anything else). */
const isMoney = (value: unknown): value is string =>
	typeof value === 'string' && value.length <= 32 && decimalToCents(value) !== null;
const isInstant = (value: unknown): value is string =>
	typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));

function readDocument(value: unknown): PaymentDocument | null {
	if (!isObject(value)) return null;
	const { id, version, stage, businessRevision, acceptedQuoteRevision, currency, totalAmount } =
		value;
	if (
		typeof id !== 'string' ||
		!UUID.test(id) ||
		!isCount(version, 1) ||
		!isEnum(stage) ||
		!isCount(businessRevision, 0) ||
		(acceptedQuoteRevision !== undefined &&
			acceptedQuoteRevision !== null &&
			!isCount(acceptedQuoteRevision, 1)) ||
		typeof currency !== 'string' ||
		!/^[A-Z]{3}$/.test(currency) ||
		!isMoney(totalAmount)
	)
		return null;
	return {
		id,
		version,
		stage,
		businessRevision,
		...(typeof acceptedQuoteRevision === 'number' && { acceptedQuoteRevision }),
		currency,
		totalAmount
	};
}

function readReceipt(value: unknown): PaymentReceipt | null {
	if (!isObject(value)) return null;
	const { amount, refundedAmount, receivedAt } = value;
	if (!isMoney(amount) || !isMoney(refundedAmount) || !isInstant(receivedAt)) return null;
	return { amount, refundedAmount, receivedAt };
}

/** A validated copy holding only the documented customer-safe fields, or null. */
export function readPaymentSummary(value: unknown): CustomerPaymentSummary | null {
	if (!isObject(value)) return null;
	const document = readDocument(value.document);
	const history = Array.isArray(value.history) ? value.history.map(readReceipt) : null;
	const {
		inquiryId,
		eventDate,
		lifecycle,
		mode,
		requiredAmount,
		paidAmount,
		balance,
		canPay,
		unavailableReason,
		paymentInProgress,
		reconciliationPending,
		checkoutRecoveryAvailable
	} = value;
	if (
		!document ||
		!history ||
		history.length > MAX_HISTORY ||
		history.some((receipt) => receipt === null) ||
		typeof inquiryId !== 'string' ||
		!UUID.test(inquiryId) ||
		typeof eventDate !== 'string' ||
		!DATE.test(eventDate) ||
		!isEnum(lifecycle) ||
		!isEnum(mode) ||
		!isMoney(requiredAmount) ||
		!isMoney(paidAmount) ||
		!isMoney(balance) ||
		typeof canPay !== 'boolean' ||
		(unavailableReason !== undefined && unavailableReason !== null && !isEnum(unavailableReason)) ||
		typeof paymentInProgress !== 'boolean' ||
		typeof reconciliationPending !== 'boolean' ||
		(checkoutRecoveryAvailable !== undefined && typeof checkoutRecoveryAvailable !== 'boolean')
	)
		return null;
	return {
		inquiryId,
		eventDate,
		lifecycle,
		document,
		mode,
		requiredAmount,
		paidAmount,
		balance,
		canPay,
		...(typeof unavailableReason === 'string' && { unavailableReason }),
		paymentInProgress,
		reconciliationPending,
		checkoutRecoveryAvailable: checkoutRecoveryAvailable === true,
		history: history as PaymentReceipt[]
	};
}

export function readCheckoutResponse(value: unknown): CheckoutResponse | null {
	if (!isObject(value)) return null;
	const { attemptId, url, state, outcome } = value;
	if (
		typeof attemptId !== 'string' ||
		!UUID.test(attemptId) ||
		(url !== undefined && url !== null && (typeof url !== 'string' || url.length > 4096)) ||
		!isEnum(state) ||
		!isEnum(outcome)
	)
		return null;
	return { attemptId, ...(typeof url === 'string' && { url }), state, outcome };
}

/**
 * The hosted Checkout URL to send this tab to, only for an OPEN attempt on Stripe's own Checkout
 * host over HTTPS. Anything else is refused: the page never navigates to an arbitrary URL.
 */
export function checkoutRedirect(response: CheckoutResponse): string | null {
	if (response.state !== 'OPEN' || !response.url) return null;
	try {
		const url = new URL(response.url);
		return url.protocol === 'https:' &&
			url.hostname === 'checkout.stripe.com' &&
			!url.username &&
			!url.password &&
			!url.port
			? url.href
			: null;
	} catch {
		return null;
	}
}

/** Strictly reads exactly the documented command fields (nothing else is ever forwarded). */
export function readCheckoutCommand(value: unknown): CheckoutCommand | null {
	if (!isObject(value)) return null;
	const keys = Object.keys(value);
	if (
		!keys.every((key) =>
			['expectedDocumentVersion', 'expectedBusinessRevision', 'amountMinor'].includes(key)
		)
	)
		return null;
	const { expectedDocumentVersion, expectedBusinessRevision, amountMinor } = value;
	if (!isCount(expectedDocumentVersion, 1) || !isCount(expectedBusinessRevision, 1)) return null;
	if (
		amountMinor !== undefined &&
		(!Number.isSafeInteger(amountMinor) ||
			(amountMinor as number) < 50 ||
			(amountMinor as number) > 99_999_999)
	)
		return null;
	return {
		expectedDocumentVersion,
		expectedBusinessRevision,
		...(amountMinor !== undefined && { amountMinor: amountMinor as number })
	};
}

/** Canonical bytes for a command: the same logical payment always serializes identically. */
export function serializeCommand(command: CheckoutCommand): string {
	return JSON.stringify({
		expectedDocumentVersion: command.expectedDocumentVersion,
		expectedBusinessRevision: command.expectedBusinessRevision,
		...(command.amountMinor !== undefined && { amountMinor: command.amountMinor })
	});
}

/** The error's stable code, plus only a known conflict message. Never free-form backend text. */
export function readPaymentError(value: unknown): PaymentError | null {
	if (!isObject(value) || typeof value.code !== 'string' || !/^[a-z][a-z_]{0,63}$/.test(value.code))
		return null;
	const message = (CONFLICT_MESSAGES as readonly unknown[]).includes(value.message)
		? (value.message as string)
		: undefined;
	return { code: value.code, ...(message && { message }) };
}
