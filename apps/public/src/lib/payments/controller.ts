/**
 * The customer payment page's state machine. Pure TypeScript with injected browser capabilities
 * (fetch, storage, navigation, timers, visibility), so every transition is unit-testable.
 *
 * Authority stays with commerce: the page shows what the latest summary says, sends only a
 * reviewed command, and never decides that money was received. See docs/customer-payments.md.
 */
import {
	checkoutLaunch,
	readCheckoutResponse,
	readPaymentError,
	readPaymentSummary,
	serializeCommand,
	type CheckoutCommand,
	type CheckoutUiMode,
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
	| 'embedded-closed'
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
	/** How commerce presented the opened attempt, when known. */
	uiMode: CheckoutUiMode | null;
	/** Stripe.js reported an embedded completion; commerce has not confirmed it yet. */
	completing: boolean;
};

/**
 * An open embedded Checkout to show on this page. The client secret is not a field: it stays in
 * the controller's closure, and `clientSecret()` hands it to Stripe.js only while this launch is
 * current (it rejects once the form was closed, completed, replaced or revoked). Nothing here can
 * be serialized into a credential, so state snapshots, logs or devtools copies never carry it.
 */
export type EmbeddedLaunch = {
	/** Distinct per launch: re-rendering the same launch never creates another Session. */
	readonly id: number;
	readonly attemptId: string;
	readonly purpose: 'DEPOSIT' | 'INVOICE';
	/** The amount this Session was authorized for (from the command, never a newer summary). */
	readonly amountCents: bigint;
	/** The Quote/Invoice revision the customer reviewed for this Session. */
	readonly businessRevision: number;
	clientSecret(): Promise<string>;
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
	/** Stripe's embedded form, shown in place of the payment actions while it is open. */
	embedded: EmbeddedLaunch | null;
	/**
	 * The summary was read successfully just now and may back a new payment decision. A summary
	 * kept on screen after a failed refresh is display-only; so is one older than five minutes
	 * until it is re-read (pay re-reads it first).
	 */
	summaryFresh: boolean;
	/**
	 * A payment from this tab may exist whose outcome commerce has not confirmed to the page: a
	 * saved command, a Stripe return, or one lost with a revoked link. Unavailability wording must
	 * then never imply that nothing was charged.
	 */
	paymentUncertain: boolean;
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
	/** Clock for summary freshness (milliseconds). */
	now?: () => number;
};

const POLL_DELAYS = [
	2000, 3000, 5000, 8000, 13000, 20000, 30000, 30000, 60000, 60000, 60000, 60000
];
const RETRY_DELAYS = [1500, 4000];
const SUMMARY_TIMEOUT_MS = 15_000;
const CHECKOUT_TIMEOUT_MS = 45_000;
/** A summary older than this is re-read before it can back a new payment. */
export const MAX_SUMMARY_AGE_MS = 5 * 60_000;
/** Notices about an in-flight payment, dropped once the summary no longer shows one. */
const IN_FLIGHT: NoticeKind[] = [
	'confirming',
	'checkout-cancelled-open',
	'embedded-closed',
	'checkout-open',
	'processing'
];

/** How a summary read ended for its caller. `superseded`: a newer read owns the state. */
type RefreshOutcome = 'applied' | 'failed' | 'superseded';

type FetchResult =
	| { ok: true; status: number; body: unknown }
	| { ok: false; status: number | null; error: PaymentError | null };

export function createPaymentController(deps: ControllerDeps) {
	const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
	const clearTimer =
		deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
	const pollDelays = deps.pollDelays ?? POLL_DELAYS;
	const retryDelays = deps.retryDelays ?? RETRY_DELAYS;
	const now = deps.now ?? (() => Date.now());
	const abort = new AbortController();
	const { store } = deps;
	let token: string | null = null;
	let returned: 'returned' | 'cancelled' | null = null;
	let disposed = false;
	let sending = false;
	/** Re-reading a stale summary before a payment decision. */
	let preparing = false;
	let loadedAt = 0;
	/** A saved command or Stripe return that was dropped with a revoked link. */
	let lostUncertain = false;
	let pollTimer: unknown = null;
	let pollIndex = 0;
	let pollDue = false;
	let unsubscribe: (() => void) | null = null;
	/** The open embedded launch and its client secret: memory only, never persisted or emitted. */
	let launch: { public: EmbeddedLaunch; secret: string } | null = null;
	let launchCount = 0;
	let state: PageState = {
		phase: 'initializing',
		summary: null,
		view: null,
		notice: null,
		busy: null,
		pending: null,
		polling: 'idle',
		persistent: store.persistent,
		embedded: null,
		summaryFresh: false,
		paymentUncertain: false
	};

	const uncertain = () => lostUncertain || returned !== null || store.checkout() !== null;

	function emit(patch: Partial<PageState>) {
		if (disposed) return;
		state = { ...state, ...patch, paymentUncertain: uncertain() };
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
					blocked: stored.blocked === true,
					uiMode: stored.uiMode ?? null,
					completing: stored.completing === true
				}
			: null;
	}

	/** Shows Stripe's embedded form for this tab's opened command, holding its secret in memory. */
	function openEmbedded(stored: StoredCheckout, attemptId: string, secret: string) {
		const id = ++launchCount;
		const embedded: EmbeddedLaunch = {
			id,
			attemptId,
			purpose: stored.purpose,
			amountCents: BigInt(stored.amountCents),
			businessRevision: stored.command.expectedBusinessRevision,
			clientSecret: () =>
				launch?.public.id === id && !disposed
					? Promise.resolve(launch.secret)
					: Promise.reject(new Error('This payment form is no longer active.'))
		};
		launch = { public: embedded, secret };
		return embedded;
	}

	/** Forgets the client secret so the form unmounts. The saved command (and Session) remain. */
	function discardEmbedded() {
		launch = null;
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
				derived = launch
					? null // The customer is still in Stripe's form on this page.
					: returned === 'cancelled'
						? 'checkout-cancelled-open'
						: returned === 'returned' || stored.completing || stored.uiMode !== 'EMBEDDED'
							? 'confirming'
							: 'embedded-closed';
			} else {
				// The attempt is no longer active: commerce has settled, expired or failed it.
				derived = outcomeNotice(stored, summary);
				store.forgetCheckout();
			}
		}
		// The embedded form stays only while commerce still shows this tab's attempt underway: a
		// settled, expired, superseded or staff-changed authorization is never left mounted.
		if (launch && (view.kind !== 'in-progress' || !store.checkout())) discardEmbedded();
		// An action's own result wins; a background read keeps the current notice unless the stored
		// checkout says something newer. In-flight wording never outlives the payment it describes.
		let notice = explicit !== undefined ? (explicit ?? derived) : (derived ?? state.notice);
		if (notice === 'refresh-failed') notice = derived;
		if (notice && IN_FLIGHT.includes(notice) && view.kind !== 'in-progress')
			notice = derived && !IN_FLIGHT.includes(derived) ? derived : null;
		// Once a summary has resolved this tab's checkout, the return marker has been accounted for.
		if (!store.checkout()) returned = null;
		loadedAt = now();
		emit({
			phase: 'ready',
			summary,
			view,
			notice,
			pending,
			embedded: launch?.public ?? null,
			summaryFresh: true
		});
		if (view.kind === 'in-progress') startPolling();
		else stopPolling('idle');
	}

	/**
	 * Summary reads are ordered by generation: every read takes the next number, and only the
	 * latest one may change anything. A superseded read (success, failure, 404, 503 alike) is
	 * discarded untouched and reports `superseded`, so no caller mistakes it for authority.
	 */
	let summaryGeneration = 0;
	let settledGeneration = 0;
	let latestRead: Promise<RefreshOutcome> = Promise.resolve('failed');
	/** An action's notice whose own read was superseded, applied by the read that replaced it. */
	let carriedNotice: NoticeKind | null | undefined;
	const summaryInFlight = () => settledGeneration !== summaryGeneration;

	function refresh(explicit?: NoticeKind | null): Promise<RefreshOutcome> {
		if (!token || disposed) return Promise.resolve('failed');
		const generation = ++summaryGeneration;
		const bearer = token;
		if (explicit !== undefined) carriedNotice = explicit;
		emit({ busy: state.busy ?? 'refreshing' });
		latestRead = (async (): Promise<RefreshOutcome> => {
			const result = await call(
				endpoint,
				{
					method: 'GET',
					headers: { accept: 'application/json', 'x-fionas-payment-token': bearer }
				},
				SUMMARY_TIMEOUT_MS
			);
			if (disposed || generation !== summaryGeneration) return 'superseded';
			settledGeneration = generation;
			const notice = carriedNotice;
			carriedNotice = undefined;
			// Only the current read clears loading; a superseded one leaves the active read's state.
			if (state.busy === 'refreshing') emit({ busy: null });
			if (result.ok) {
				const summary = readPaymentSummary(result.body);
				if (summary) {
					applySummary(summary, notice);
					return 'applied';
				}
				failRefresh();
				return 'failed';
			}
			if (result.status === 404) linkUnavailable();
			else if (result.status === 503 && result.error?.code && isDisabled(result.error.code))
				paymentsDisabled();
			else failRefresh();
			return 'failed';
		})();
		return latestRead;
	}

	/** Waits for the latest summary read, following any that supersede it, to its own outcome. */
	async function settledRefresh(): Promise<RefreshOutcome> {
		let outcome = await refresh();
		while (outcome === 'superseded' && !disposed) outcome = await latestRead;
		return outcome;
	}

	/** A command is being sent or the tab is leaving for Stripe (a background read is not busy). */
	const isBusy = () => state.busy === 'submitting' || state.busy === 'redirecting';

	const isDisabled = (code: string) =>
		code === 'stripe_disabled' || code === 'payments_unavailable';

	function failRefresh() {
		// Whatever is on screen stays readable, but it can no longer back a new payment.
		if (state.summary) emit({ notice: 'refresh-failed', summaryFresh: false });
		else emit({ phase: 'unreachable', summaryFresh: false });
		if (state.polling === 'active') schedulePoll();
	}

	function linkUnavailable() {
		lostUncertain = uncertain();
		token = null;
		store.forgetToken();
		store.forgetCheckout();
		discardEmbedded();
		stopPolling('idle');
		emit({
			phase: 'link-unavailable',
			summary: null,
			view: null,
			notice: null,
			pending: null,
			embedded: null,
			summaryFresh: false
		});
	}

	function paymentsDisabled() {
		stopPolling('idle');
		discardEmbedded();
		emit({
			phase: 'payments-disabled',
			notice: null,
			busy: null,
			embedded: null,
			summaryFresh: false
		});
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

	const termsKey = (terms: PayableTerms) =>
		[terms.purpose, terms.documentVersion, terms.businessRevision, terms.amountCents].join(':');

	/**
	 * The reviewed terms a new payment may use, or null. Requires a fresh summary; one past
	 * MAX_SUMMARY_AGE_MS is re-read first, and if its terms moved the customer must review again.
	 */
	async function currentTerms(
		pick: (view: PaymentView | null) => PayableTerms | null
	): Promise<PayableTerms | null> {
		const reviewed = pick(state.view);
		// A read in flight may replace these terms: never decide on the one it will supersede.
		if (!reviewed || !state.summaryFresh || summaryInFlight()) return null;
		if (now() - loadedAt <= MAX_SUMMARY_AGE_MS) return reviewed;
		preparing = true;
		let outcome: RefreshOutcome;
		try {
			outcome = await settledRefresh();
		} finally {
			preparing = false;
		}
		// Only the latest accepted summary, with nothing newer pending, may authorize a payment.
		if (disposed || outcome !== 'applied' || summaryInFlight() || !state.summaryFresh) return null;
		const latest = pick(state.view);
		if (!latest || termsKey(latest) !== termsKey(reviewed)) {
			emit({ notice: 'terms-changed' });
			return null;
		}
		return latest;
	}

	/** Sends one stored command, retrying only the identical key/body after an ambiguous result. */
	async function send(stored: StoredCheckout, fresh = false) {
		// An open embedded form already holds this tab's only authorization.
		if (sending || disposed || !token || launch) return;
		sending = true;
		const sendingCommand: StoredCheckout = {
			...stored,
			phase: 'sending',
			blocked: undefined,
			completing: undefined
		};
		// Persisted before transmission: a lost response or closed tab can only resend this.
		store.saveCheckout(sendingCommand);
		emit({ busy: 'submitting', pending: pendingOf(sendingCommand, false), notice: null });
		const body = serializeCommand(sendingCommand.command);
		let result: FetchResult;
		let unknownEarlier = false;
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
			unknownEarlier = true;
			await wait(retryDelays[attempt]);
			if (disposed) return;
		}
		sending = false;
		if (result.ok) {
			const response = readCheckoutResponse(result.body);
			// Each attempt names its own immutable mode: one opened before a configuration change
			// keeps launching the way it was created.
			const launchable = response && checkoutLaunch(response);
			const opened: StoredCheckout = {
				...sendingCommand,
				phase: 'redirected',
				...(response?.uiMode && { uiMode: response.uiMode })
			};
			if (launchable?.mode === 'HOSTED') {
				store.saveCheckout(opened);
				emit({ busy: 'redirecting' });
				deps.navigate(launchable.url);
				return;
			}
			if (response && launchable?.mode === 'EMBEDDED') {
				// The customer stays here. Only nonsecret metadata is saved; the secret stays in memory.
				store.saveCheckout(opened);
				const embedded = openEmbedded(opened, response.attemptId, launchable.clientSecret);
				emit({ busy: null, notice: null, embedded, pending: pendingOf(opened, false) });
				return refresh(null);
			}
			emit({ busy: null });
			if (!response) return refresh('ambiguous');
			if (response.state === 'EXPIRED' || response.state === 'FAILED') {
				// A historical outcome: this key never authorizes a replacement.
				store.forgetCheckout();
				return refresh('checkout-expired');
			}
			store.saveCheckout(opened);
			return refresh(response.state === 'OPEN' ? 'checkout-open' : undefined);
		}
		emit({ busy: null });
		const failure = classifyCheckoutFailure(result.status, result.error);
		// Disabled payments are refused before commerce looks at the key, so they say nothing about
		// an earlier send of this command: only a brand-new command refused at once is discarded.
		const keep =
			keepsCommand(failure) || (failure === 'payments-disabled' && (!fresh || unknownEarlier));
		if (!keep) store.forgetCheckout();
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
			if (sending || preparing || isBusy() || launch || store.checkout()) return;
			const terms = await currentTerms((view) =>
				view?.kind === 'deposit-due' || view?.kind === 'balance-due' ? view.terms : null
			);
			if (!terms || sending || store.checkout()) return;
			const stored = buildCommand(terms, choice);
			if (stored) await send(stored, true);
		},
		/**
		 * "Check previous payment and continue": resends this tab's original command when it has
		 * one, otherwise one deliberate fresh command against the current reviewed terms. Recovery
		 * conflicts claim no key and are never followed by another automatic attempt.
		 */
		async recover(choice: AmountChoice) {
			if (sending || preparing || isBusy() || launch) return;
			const stored = store.checkout();
			// This tab's own command: resending it is always safe (same key, same authorization).
			if (stored && !stored.blocked) return send(stored);
			if (stored) return;
			const terms = await currentTerms((view) =>
				view?.kind === 'in-progress' ? view.recovery : null
			);
			if (!terms || sending || store.checkout()) return;
			const fresh = buildCommand(terms, choice);
			if (fresh) await send(fresh, true);
		},
		/** Resends the identical stored command after an ambiguous outcome. */
		async retry() {
			const stored = store.checkout();
			if (!stored || stored.blocked || sending || isBusy() || launch) return;
			await send(stored);
		},
		/**
		 * Stripe.js reported that the embedded Checkout completed. That never proves payment: the
		 * form is removed, new payments stay closed, and the page waits (with fresh bounded
		 * polling) until commerce's summary shows the applied payment.
		 */
		embeddedComplete(id: number) {
			if (disposed || launch?.public.id !== id) return;
			discardEmbedded();
			const stored = store.checkout();
			if (stored) store.saveCheckout({ ...stored, completing: true });
			stopPolling('idle');
			emit({ embedded: null, notice: 'confirming', pending: pendingOf(store.checkout(), false) });
			void refresh('confirming');
		},
		/**
		 * Back to the booking overview. Closing the form neither cancels nor expires the Session
		 * and proves nothing about money: the saved command stays, and continuing resends that
		 * same key and body to reach the same Session.
		 */
		closeEmbedded() {
			if (disposed || !launch) return;
			discardEmbedded();
			emit({ embedded: null });
			void refresh(null);
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
			discardEmbedded();
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
