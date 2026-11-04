/**
 * The customer payment page's state machine. Pure TypeScript with injected browser capabilities
 * (fetch, storage, navigation, timers, visibility), so every transition is unit-testable.
 *
 * Authority stays with commerce: the page shows what the latest summary says, sends only a
 * reviewed command, and never decides that money was received. See docs/customer-payments.md.
 */
import {
	checkoutRedirect,
	readCheckoutResponse,
	readPaymentError,
	readPaymentSummary,
	serializeCommand,
	type CheckoutCommand,
	type CustomerPaymentSummary,
	type PaymentError
} from './contract.js';
import {
	classifyCheckoutFailure,
	keepsCommand,
	readCheckoutReturn,
	readFragmentToken,
	type CheckoutFailure,
	type PaymentStore,
	type StoredCheckout
} from './checkout.js';
import { decimalToCents, STRIPE_MAX_CENTS, STRIPE_MIN_CENTS } from './money.js';
import { paymentView, type PayableTerms, type PaymentView } from './view.js';

export type NoticeKind =
	| 'deposit-confirmed'
	| 'payment-received'
	| 'confirming'
	| 'checkout-cancelled-open'
	| 'checkout-not-completed'
	| 'checkout-expired'
	| 'refresh-failed'
	| Exclude<CheckoutFailure, 'link-unavailable' | 'payments-disabled'>;

export type PagePhase =
	| 'initializing'
	| 'link-required'
	| 'link-incomplete'
	| 'link-unavailable'
	| 'unreachable'
	| 'payments-disabled'
	| 'ready';

export type PendingCheckout = {
	purpose: 'DEPOSIT' | 'INVOICE';
	amountCents: bigint;
	/** No response was received: the outcome is unknown and only the same command may be resent. */
	ambiguous: boolean;
	/** CHECKOUT_KEY_REUSED: never resent; the customer must deliberately start over. */
	blocked: boolean;
};

export type PageState = {
	phase: PagePhase;
	summary: CustomerPaymentSummary | null;
	view: PaymentView | null;
	notice: NoticeKind | null;
	busy: 'submitting' | 'redirecting' | 'refreshing' | null;
	pending: PendingCheckout | null;
	polling: 'idle' | 'active' | 'exhausted';
	/** False when sessionStorage is unavailable: leaving the page loses the link for this tab. */
	persistent: boolean;
};

/** The customer's amount choice. `null` pays the deposit or the whole Invoice balance. */
export type AmountChoice = { partialCents: bigint | null };

export type ControllerDeps = {
	publicId: string;
	store: PaymentStore;
	/** `location.hash` and `location.search` at startup. */
	hash: string;
	search: string;
	/** Replaces the current history entry with the bare `/pay/{publicId}` path. */
	clearUrl(): void;
	fetch: typeof fetch;
	/** Sends this tab to the hosted Checkout URL. */
	navigate(url: string): void;
	uuid(): string;
	visible(): boolean;
	onVisible(listener: () => void): () => void;
	onState(state: PageState): void;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
	/** Summary polling backoff while a payment is underway (bounded). */
	pollDelays?: number[];
	/** Same-key retry delays after an ambiguous checkout response (bounded). */
	retryDelays?: number[];
};

const POLL_DELAYS = [
	2000, 3000, 5000, 8000, 13000, 20000, 30000, 30000, 60000, 60000, 60000, 60000
];
const RETRY_DELAYS = [1500, 4000];
const SUMMARY_TIMEOUT_MS = 15_000;
const CHECKOUT_TIMEOUT_MS = 45_000;
/** Notices about an in-flight payment, dropped once the summary no longer shows one. */
const IN_FLIGHT: NoticeKind[] = [
	'confirming',
	'checkout-cancelled-open',
	'checkout-open',
	'processing'
];

type FetchResult =
	| { ok: true; status: number; body: unknown }
	| { ok: false; status: number | null; error: PaymentError | null };

export function createPaymentController(deps: ControllerDeps) {
	const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
	const clearTimer =
		deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
	const pollDelays = deps.pollDelays ?? POLL_DELAYS;
	const retryDelays = deps.retryDelays ?? RETRY_DELAYS;
	const abort = new AbortController();
	const { store } = deps;
	let token: string | null = null;
	let returned: 'returned' | 'cancelled' | null = null;
	let disposed = false;
	let sending = false;
	let pollTimer: unknown = null;
	let pollIndex = 0;
	let pollDue = false;
	let unsubscribe: (() => void) | null = null;
	let state: PageState = {
		phase: 'initializing',
		summary: null,
		view: null,
		notice: null,
		busy: null,
		pending: null,
		polling: 'idle',
		persistent: store.persistent
	};

	function emit(patch: Partial<PageState>) {
		if (disposed) return;
		state = { ...state, ...patch };
		deps.onState(state);
	}

	const wait = (ms: number) =>
		new Promise<void>((resolve) => {
			setTimer(resolve, ms);
		});

	async function call(path: string, init: RequestInit, timeoutMs: number): Promise<FetchResult> {
		let response: Response;
		try {
			response = await deps.fetch(path, {
				...init,
				cache: 'no-store',
				credentials: 'omit',
				referrerPolicy: 'no-referrer',
				signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)])
			});
		} catch {
			return { ok: false, status: null, error: null };
		}
		const body: unknown = await response.json().catch(() => null);
		return response.ok
			? { ok: true, status: response.status, body }
			: { ok: false, status: response.status, error: readPaymentError(body) };
	}

	const endpoint = `/api/payments/${encodeURIComponent(deps.publicId)}`;

	function pendingOf(stored: StoredCheckout | null, ambiguous: boolean): PendingCheckout | null {
		return stored
			? {
					purpose: stored.purpose,
					amountCents: BigInt(stored.amountCents),
					ambiguous,
					blocked: stored.blocked === true
				}
			: null;
	}

	/** The confirmation a finished checkout supports, judged only from the authoritative summary. */
	function outcomeNotice(stored: StoredCheckout, summary: CustomerPaymentSummary): NoticeKind {
		if (
			stored.purpose === 'DEPOSIT' &&
			stored.lifecycleBefore === 'QUOTED' &&
			['BOOKED', 'SERVED', 'CLOSED'].includes(summary.lifecycle)
		)
			return 'deposit-confirmed';
		const before = decimalToCents(stored.paidBefore);
		const now = decimalToCents(summary.paidAmount);
		if (
			stored.purpose === 'INVOICE' &&
			before !== null &&
			now !== null &&
			now > before &&
			summary.lifecycle !== 'QUOTED'
		)
			return 'payment-received';
		return 'checkout-not-completed';
	}

	/** Applies a fresh summary, resolving any stored checkout against it. */
	function applySummary(summary: CustomerPaymentSummary, explicit?: NoticeKind | null) {
		const view = paymentView(summary);
		const stored = store.checkout();
		let derived: NoticeKind | null = null;
		let pending: PendingCheckout | null = null;
		if (stored?.blocked) {
			pending = pendingOf(stored, false);
			derived = 'key-reused';
		} else if (stored?.phase === 'sending') {
			// Unknown only when no request for it is in flight (a background read during a send is not).
			pending = pendingOf(stored, !sending);
			derived = sending ? null : 'ambiguous';
		} else if (stored?.phase === 'redirected') {
			if (summary.paymentInProgress) {
				pending = pendingOf(stored, false);
				derived = returned === 'cancelled' ? 'checkout-cancelled-open' : 'confirming';
			} else {
				// The attempt is no longer active: commerce has settled, expired or failed it.
				derived = outcomeNotice(stored, summary);
				store.forgetCheckout();
			}
		}
		// An action's own result wins; a background read keeps the current notice unless the stored
		// checkout says something newer. In-flight wording never outlives the payment it describes.
		let notice = explicit !== undefined ? (explicit ?? derived) : (derived ?? state.notice);
		if (notice === 'refresh-failed') notice = derived;
		if (notice && IN_FLIGHT.includes(notice) && view.kind !== 'in-progress')
			notice = derived && !IN_FLIGHT.includes(derived) ? derived : null;
		emit({ phase: 'ready', summary, view, notice, pending });
		if (view.kind === 'in-progress') startPolling();
		else stopPolling('idle');
	}

	async function refresh(explicit?: NoticeKind | null): Promise<void> {
		if (!token || disposed) return;
		emit({ busy: state.busy ?? 'refreshing' });
		const result = await call(
			endpoint,
			{ method: 'GET', headers: { accept: 'application/json', 'x-fionas-payment-token': token } },
			SUMMARY_TIMEOUT_MS
		);
		if (disposed) return;
		if (state.busy === 'refreshing') emit({ busy: null });
		if (result.ok) {
			const summary = readPaymentSummary(result.body);
			if (summary) return applySummary(summary, explicit);
			return failRefresh();
		}
		if (result.status === 404) return linkUnavailable();
		if (result.status === 503 && result.error?.code && isDisabled(result.error.code))
			return paymentsDisabled();
		return failRefresh();
	}

	/** A command is being sent or the tab is leaving for Stripe (a background read is not busy). */
	const isBusy = () => state.busy === 'submitting' || state.busy === 'redirecting';

	const isDisabled = (code: string) =>
		code === 'stripe_disabled' || code === 'payments_unavailable';

	function failRefresh() {
		if (state.summary) emit({ notice: 'refresh-failed' });
		else emit({ phase: 'unreachable' });
		if (state.polling === 'active') schedulePoll();
	}

	function linkUnavailable() {
		token = null;
		store.forgetToken();
		store.forgetCheckout();
		stopPolling('idle');
		emit({ phase: 'link-unavailable', summary: null, view: null, notice: null, pending: null });
	}

	function paymentsDisabled() {
		stopPolling('idle');
		emit({ phase: 'payments-disabled', notice: null, busy: null });
	}

	// Polling: bounded backoff, only while the page is visible, only while a payment is underway.
	function startPolling() {
		if (state.polling === 'active') {
			if (pollTimer === null && !pollDue) schedulePoll();
			return;
		}
		if (state.polling === 'exhausted') return;
		pollIndex = 0;
		emit({ polling: 'active' });
		schedulePoll();
	}

	function schedulePoll() {
		if (pollTimer !== null || disposed) return;
		if (pollIndex >= pollDelays.length) {
			emit({ polling: 'exhausted' });
			return;
		}
		pollTimer = setTimer(() => {
			pollTimer = null;
			if (!deps.visible()) {
				pollDue = true;
				return;
			}
			void refresh();
		}, pollDelays[pollIndex++]);
	}

	function stopPolling(next: 'idle' | 'exhausted') {
		if (pollTimer !== null) clearTimer(pollTimer);
		pollTimer = null;
		pollDue = false;
		if (state.polling !== next) emit({ polling: next });
	}

	function visibilityChanged() {
		if (pollDue && deps.visible() && !disposed) {
			pollDue = false;
			void refresh();
		}
	}

	function buildCommand(terms: PayableTerms, choice: AmountChoice): StoredCheckout | null {
		const summary = state.summary;
		if (!summary) return null;
		const command: CheckoutCommand = {
			expectedDocumentVersion: terms.documentVersion,
			expectedBusinessRevision: terms.businessRevision
		};
		let amount = terms.amountCents;
		if (terms.purpose === 'INVOICE') {
			if (choice.partialCents !== null) {
				const cents = choice.partialCents;
				if (cents < STRIPE_MIN_CENTS || cents > STRIPE_MAX_CENTS || cents > terms.amountCents)
					return null;
				command.amountMinor = Number(cents);
				amount = cents;
			} else if (!terms.fullAllowed) return null;
		} else if (choice.partialCents !== null) return null; // A deposit is always paid in full.
		return {
			key: deps.uuid(),
			command,
			purpose: terms.purpose,
			amountCents: amount.toString(),
			paidBefore: summary.paidAmount,
			lifecycleBefore: summary.lifecycle,
			phase: 'sending'
		};
	}

	/** Sends one stored command, retrying only the identical key/body after an ambiguous result. */
	async function send(stored: StoredCheckout) {
		if (sending || disposed || !token) return;
		sending = true;
		const sendingCommand: StoredCheckout = { ...stored, phase: 'sending', blocked: undefined };
		// Persisted before transmission: a lost response or closed tab can only resend this.
		store.saveCheckout(sendingCommand);
		emit({ busy: 'submitting', pending: pendingOf(sendingCommand, false), notice: null });
		const body = serializeCommand(sendingCommand.command);
		let result: FetchResult;
		for (let attempt = 0; ; attempt++) {
			result = await call(
				`${endpoint}/checkout-sessions`,
				{
					method: 'POST',
					headers: {
						accept: 'application/json',
						'content-type': 'application/json',
						'idempotency-key': sendingCommand.key,
						'x-fionas-payment-token': token
					},
					body
				},
				CHECKOUT_TIMEOUT_MS
			);
			if (disposed) return;
			const retryable =
				!result.ok && classifyCheckoutFailure(result.status, result.error) === 'ambiguous';
			if (!retryable || attempt >= retryDelays.length) break;
			await wait(retryDelays[attempt]);
			if (disposed) return;
		}
		sending = false;
		if (result.ok) {
			const response = readCheckoutResponse(result.body);
			const redirect = response && checkoutRedirect(response);
			if (response && redirect) {
				store.saveCheckout({ ...sendingCommand, phase: 'redirected' });
				emit({ busy: 'redirecting' });
				deps.navigate(redirect);
				return;
			}
			emit({ busy: null });
			if (!response) return refresh('ambiguous');
			if (response.state === 'EXPIRED' || response.state === 'FAILED') {
				// A historical outcome: this key never authorizes a replacement.
				store.forgetCheckout();
				return refresh('checkout-expired');
			}
			store.saveCheckout({ ...sendingCommand, phase: 'redirected' });
			return refresh(response.state === 'OPEN' ? 'checkout-open' : undefined);
		}
		emit({ busy: null });
		const failure = classifyCheckoutFailure(result.status, result.error);
		if (!keepsCommand(failure)) store.forgetCheckout();
		if (failure === 'key-reused') store.saveCheckout({ ...sendingCommand, blocked: true });
		if (failure === 'link-unavailable') return linkUnavailable();
		if (failure === 'payments-disabled') return paymentsDisabled();
		return refresh(failure);
	}

	return {
		/** Captures the bearer, cleans the URL and loads the authoritative summary. */
		async start() {
			unsubscribe = deps.onVisible(visibilityChanged);
			const fragment = readFragmentToken(deps.hash);
			returned = readCheckoutReturn(deps.search);
			if (deps.hash || returned || deps.search) deps.clearUrl();
			if (fragment.kind === 'malformed') return emit({ phase: 'link-incomplete' });
			if (fragment.kind === 'token') {
				// A link opened again (perhaps a rotated one) replaces this tab's earlier bearer.
				store.saveToken(fragment.token);
				token = fragment.token;
			} else token = store.token();
			if (!token) return emit({ phase: 'link-required' });
			await refresh();
		},
		/** A deliberate payment of the reviewed terms. Ignored while anything is in flight. */
		async pay(choice: AmountChoice) {
			const view = state.view;
			if (sending || isBusy() || store.checkout()) return;
			if (view?.kind !== 'deposit-due' && view?.kind !== 'balance-due') return;
			const stored = buildCommand(view.terms, choice);
			if (stored) await send(stored);
		},
		/**
		 * "Check previous payment and continue": resends this tab's original command when it has
		 * one, otherwise one deliberate fresh command against the current reviewed terms. Recovery
		 * conflicts claim no key and are never followed by another automatic attempt.
		 */
		async recover(choice: AmountChoice) {
			if (sending || isBusy()) return;
			const stored = store.checkout();
			if (stored && !stored.blocked) return send(stored);
			if (stored) return;
			const view = state.view;
			if (view?.kind !== 'in-progress' || !view.recovery) return;
			const fresh = buildCommand(view.recovery, choice);
			if (fresh) await send(fresh);
		},
		/** Resends the identical stored command after an ambiguous outcome. */
		async retry() {
			const stored = store.checkout();
			if (!stored || stored.blocked || sending || isBusy()) return;
			await send(stored);
		},
		/** Deliberately abandons a blocked command and reviews the current terms again. */
		async startOver() {
			const stored = store.checkout();
			if (!stored?.blocked || sending) return;
			store.forgetCheckout();
			await refresh(null);
		},
		/** A manual summary read; also restarts an exhausted poll. */
		async refresh() {
			if (sending) return;
			if (state.polling === 'exhausted') emit({ polling: 'idle' });
			await refresh();
		},
		dispose() {
			disposed = true;
			abort.abort();
			if (pollTimer !== null) clearTimer(pollTimer);
			unsubscribe?.();
		},
		get state() {
			return state;
		}
	};
}

export type PaymentController = ReturnType<typeof createPaymentController>;
