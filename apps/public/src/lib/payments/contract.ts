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

/** How commerce presents an attempt. Immutable per attempt: a same-key retry keeps its mode. */
export type CheckoutUiMode = 'HOSTED' | 'EMBEDDED';

/**
 * A validated checkout answer. Only an OPEN attempt carries a launch credential, and exactly the
 * one its `uiMode` names: `url` for HOSTED, `clientSecret` for EMBEDDED. Both are short-lived
 * credentials: never persisted, logged or put in a URL. `uiMode` is absent only for a non-OPEN
 * answer from a commerce release that predates presentation modes.
 */
export type CheckoutResponse = {
	attemptId: string;
	uiMode?: CheckoutUiMode;
	url?: string;
	clientSecret?: string;
	state: string;
	outcome: string;
};

/** What the page may do with an OPEN attempt: navigate this tab, or mount Stripe's form here. */
export type CheckoutLaunch =
	{ mode: 'HOSTED'; url: string } | { mode: 'EMBEDDED'; clientSecret: string };

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
/**
 * A Checkout Session client secret, checked structurally only. Stripe documents no format for
 * `client_secret` (no prefix, charset or length), so a stricter pattern would refuse genuine
 * secrets: one non-empty token of visible ASCII, bounded in size. It is only ever handed to
 * Stripe.js, which validates it. A Stripe secret or restricted API key is still refused, so a
 * misconfiguration can never put one in a browser.
 */
export function isClientSecret(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		/^[\x21-\x7e]{1,4096}$/.test(value) &&
		!/^(sk|rk)_(test|live)_/.test(value)
	);
}
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

const absent = (value: unknown) => value === undefined || value === null;

/**
 * Reads a checkout answer, failing closed. An OPEN answer must name a known `uiMode` and carry
 * exactly its one credential: a HOSTED url or an EMBEDDED client secret, never both, never the
 * other. Unknown modes and contradictory or incomplete OPEN answers are refused (null). A legacy
 * OPEN answer with no `uiMode` is read as HOSTED only when it carries a url and nothing else;
 * EMBEDDED is never inferred. A non-OPEN answer keeps its state and outcome, and any credential
 * on it is dropped: nothing can be launched from it.
 */
export function readCheckoutResponse(value: unknown): CheckoutResponse | null {
	const read = inspectCheckoutResponse(value);
	return 'response' in read ? read.response : null;
}

/**
 * Why a checkout answer was refused: a fixed code naming the failed check, safe to log. It never
 * carries a value from the answer (the url and client secret are credentials).
 */
export type CheckoutResponseProblem =
	| 'not_object'
	| 'attempt_id'
	| 'state'
	| 'outcome'
	| 'ui_mode'
	| 'url'
	| 'client_secret'
	| 'credentials';

/** `readCheckoutResponse`, also saying which check refused an answer (for operator logs). */
export function inspectCheckoutResponse(
	value: unknown
): { response: CheckoutResponse } | { problem: CheckoutResponseProblem } {
	if (!isObject(value)) return { problem: 'not_object' };
	const { attemptId, uiMode, url, clientSecret, state, outcome } = value;
	if (typeof attemptId !== 'string' || !UUID.test(attemptId)) return { problem: 'attempt_id' };
	if (!isEnum(state)) return { problem: 'state' };
	if (!isEnum(outcome)) return { problem: 'outcome' };
	if (!(absent(uiMode) || uiMode === 'HOSTED' || uiMode === 'EMBEDDED'))
		return { problem: 'ui_mode' };
	const mode = absent(uiMode) ? undefined : (uiMode as CheckoutUiMode);
	if (state !== 'OPEN')
		return { response: { attemptId, ...(mode && { uiMode: mode }), state, outcome } };
	const hasUrl = typeof url === 'string' && url.length > 0 && url.length <= 4096;
	const hasSecret = isClientSecret(clientSecret);
	if (!(hasUrl || absent(url))) return { problem: 'url' };
	if (!(hasSecret || absent(clientSecret))) return { problem: 'client_secret' };
	if ((mode === 'HOSTED' || mode === undefined) && hasUrl && !hasSecret)
		return { response: { attemptId, uiMode: 'HOSTED', url: url as string, state, outcome } };
	if (mode === 'EMBEDDED' && hasSecret && !hasUrl)
		return {
			response: {
				attemptId,
				uiMode: 'EMBEDDED',
				clientSecret: clientSecret as string,
				state,
				outcome
			}
		};
	return { problem: 'credentials' };
}

/**
 * The hosted Checkout URL to send this tab to, only for an OPEN attempt on Stripe's own Checkout
 * host over HTTPS. Anything else is refused: the page never navigates to an arbitrary URL.
 */
export function checkoutRedirect(response: CheckoutResponse): string | null {
	if (response.state !== 'OPEN' || response.uiMode !== 'HOSTED' || !response.url) return null;
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

/** How to present an OPEN attempt, from its own immutable mode; null when it can't be launched. */
export function checkoutLaunch(response: CheckoutResponse): CheckoutLaunch | null {
	if (response.state !== 'OPEN') return null;
	if (response.uiMode === 'EMBEDDED')
		return isClientSecret(response.clientSecret)
			? { mode: 'EMBEDDED', clientSecret: response.clientSecret }
			: null;
	const url = checkoutRedirect(response);
	return url ? { mode: 'HOSTED', url } : null;
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
