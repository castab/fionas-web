/**
 * Browser-side bearer and checkout-command handling for `/pay/{publicId}`.
 *
 * - The bearer arrives in the URL fragment, is kept only in this tab's sessionStorage (scoped to
 *   the publicId) and the fragment is removed at once. Never localStorage, cookies, query strings,
 *   server data, logs or analytics.
 * - One logical payment owns one Idempotency-Key and one exact body, persisted before the request
 *   is sent, and reused for every retry of that payment.
 */
import {
	IDEMPOTENCY_KEY,
	PAYMENT_TOKEN,
	isOnPageCheckoutMode,
	readCheckoutCommand,
	type CheckoutCommand,
	type CheckoutUiMode,
	type PaymentError
} from './contract.js';

export type FragmentToken =
	{ kind: 'none' } | { kind: 'token'; token: string } | { kind: 'malformed' };

/** Reads `#<bearer>` from a location hash. Anything else that is present is malformed. */
export function readFragmentToken(hash: string): FragmentToken {
	const value = hash.startsWith('#') ? hash.slice(1) : hash;
	if (value === '') return { kind: 'none' };
	return PAYMENT_TOKEN.test(value) ? { kind: 'token', token: value } : { kind: 'malformed' };
}

/** What a returning Stripe redirect says about navigation. It never proves an outcome. */
export function readCheckoutReturn(search: string): 'returned' | 'cancelled' | null {
	const value = new URLSearchParams(search).get('checkout');
	return value === 'returned' || value === 'cancelled' ? value : null;
}

/**
 * A checkout command saved before transmission. `phase` is `sending` until a response arrives
 * (an ambiguous outcome stays `sending`), then `redirected` once commerce answered with a
 * provider state: a Checkout Session was opened or already settled. The
 * literal predates Embedded Checkout and is kept so commands saved by either release survive a
 * deploy in both directions; it no longer implies that this tab navigated away.
 *
 * Only the command's identity, exact body, reviewed terms and nonsecret recovery hints are kept:
 * never a hosted Checkout URL or a client secret. Either is obtained again only by
 * resending this same key and body.
 */
export type StoredCheckout = {
	key: string;
	command: CheckoutCommand;
	purpose: 'DEPOSIT' | 'INVOICE';
	/** Exact cents reviewed by the customer, also used to verify the Stripe Session total. */
	amountCents: string;
	/** Authoritative paid amount and lifecycle when the customer decided, for confirmations. */
	paidBefore: string;
	lifecycleBefore: string;
	phase: 'sending' | 'redirected';
	/** Set after CHECKOUT_KEY_REUSED: never resent, only deliberately discarded. */
	blocked?: boolean;
	/** How commerce presented the opened attempt (nonsecret; wording and resume only). */
	uiMode?: CheckoutUiMode;
	/**
	 * Confirmation started or Stripe reported completion. Wait for commerce to show the
	 * payment before taking another payment action.
	 */
	completing?: boolean;
};

export type PaymentStore = {
	/** False when sessionStorage is unusable; the page then works only while it stays open. */
	readonly persistent: boolean;
	token(): string | null;
	saveToken(token: string): void;
	forgetToken(): void;
	checkout(): StoredCheckout | null;
	saveCheckout(checkout: StoredCheckout): void;
	forgetCheckout(): void;
};

const isStoredCheckout = (value: unknown): value is StoredCheckout => {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.key === 'string' &&
		IDEMPOTENCY_KEY.test(v.key) &&
		readCheckoutCommand(v.command) !== null &&
		(v.purpose === 'DEPOSIT' || v.purpose === 'INVOICE') &&
		typeof v.amountCents === 'string' &&
		/^\d{1,12}$/.test(v.amountCents) &&
		typeof v.paidBefore === 'string' &&
		v.paidBefore.length <= 32 &&
		typeof v.lifecycleBefore === 'string' &&
		v.lifecycleBefore.length <= 64 &&
		(v.phase === 'sending' || v.phase === 'redirected') &&
		(v.blocked === undefined || typeof v.blocked === 'boolean') &&
		(v.uiMode === undefined || v.uiMode === 'HOSTED' || isOnPageCheckoutMode(v.uiMode)) &&
		(v.completing === undefined || typeof v.completing === 'boolean')
	);
};

/**
 * Tab-scoped storage for one publicId. If sessionStorage is unavailable (blocked, private mode),
 * values live only in this closure, which belongs to the page instance: never a global store.
 */
export function paymentStore(publicId: string, storage: Storage | null): PaymentStore {
	const tokenKey = `fionas.pay.${publicId}.token`;
	const checkoutKey = `fionas.pay.${publicId}.checkout`;
	const memory = new Map<string, string>();
	let persistent = false;
	try {
		if (storage) {
			const probe = `fionas.pay.probe`;
			storage.setItem(probe, '1');
			storage.removeItem(probe);
			persistent = true;
		}
	} catch {
		persistent = false;
	}
	const get = (key: string) => {
		if (!persistent) return memory.get(key) ?? null;
		try {
			return storage!.getItem(key);
		} catch {
			return memory.get(key) ?? null;
		}
	};
	const set = (key: string, value: string) => {
		memory.set(key, value);
		if (!persistent) return;
		try {
			storage!.setItem(key, value);
		} catch {
			// Quota or policy failure: keep the in-memory copy for this page's lifetime.
		}
	};
	const remove = (key: string) => {
		memory.delete(key);
		if (!persistent) return;
		try {
			storage!.removeItem(key);
		} catch {
			// Nothing further to clean up.
		}
	};
	return {
		get persistent() {
			return persistent;
		},
		token() {
			const value = get(tokenKey);
			return value !== null && PAYMENT_TOKEN.test(value) ? value : null;
		},
		saveToken: (token) => set(tokenKey, token),
		forgetToken: () => remove(tokenKey),
		checkout() {
			const raw = get(checkoutKey);
			if (raw === null) return null;
			try {
				const value: unknown = JSON.parse(raw);
				return isStoredCheckout(value) ? value : null;
			} catch {
				return null;
			}
		},
		saveCheckout: (checkout) => set(checkoutKey, JSON.stringify(checkout)),
		forgetCheckout: () => remove(checkoutKey)
	};
}

/**
 * How a checkout POST ended, from the status and stable error code alone.
 *
 * - `ambiguous`: a network failure, timeout or 5xx. The command may have committed, so the same
 *   key and body are kept for a bounded retry; no new payment is ever authorized because of it.
 * - Recovery conflicts (`checkout-open`, `processing`, `state-changed`, `recovery-conflict`,
 *   `reconciliation-required`) claim no key and must not start a fresh-key loop.
 * - Anything unrecognized is `refused`: refresh and require review. It never enables payment.
 */
export type CheckoutFailure =
	| 'ambiguous'
	| 'terms-changed'
	| 'key-reused'
	| 'reconciliation-pending'
	| 'checkout-open'
	| 'processing'
	| 'state-changed'
	| 'recovery-conflict'
	| 'reconciliation-required'
	| 'invalid-amount'
	| 'link-unavailable'
	| 'payments-disabled'
	| 'malformed'
	| 'refused';

export function classifyCheckoutFailure(
	status: number | null,
	error: PaymentError | null
): CheckoutFailure {
	if (status === null) return 'ambiguous';
	const code = error?.code;
	if (status === 503 && (code === 'stripe_disabled' || code === 'payments_unavailable'))
		return 'payments-disabled';
	if (status >= 500) return 'ambiguous';
	if (status === 404) return 'link-unavailable';
	if (status === 400) return 'malformed';
	if (status === 422) return 'invalid-amount';
	if (status === 409) {
		switch (code) {
			case 'checkout_in_progress':
				return 'checkout-open';
			case 'payment_processing':
				return 'processing';
			case 'payment_state_changed':
				return 'state-changed';
			case 'checkout_recovery_conflict':
				return 'recovery-conflict';
			case 'checkout_reconciliation_required':
				return 'reconciliation-required';
			case 'conflict':
				return error?.message === 'PAYMENT_TERMS_CHANGED'
					? 'terms-changed'
					: error?.message === 'CHECKOUT_KEY_REUSED'
						? 'key-reused'
						: error?.message === 'RECONCILIATION_PENDING'
							? 'reconciliation-pending'
							: 'refused';
		}
	}
	return 'refused';
}

/** Whether a failure means the stored key/body must be kept (never replaced automatically). */
export function keepsCommand(failure: CheckoutFailure): boolean {
	return failure === 'ambiguous' || failure === 'key-reused';
}
