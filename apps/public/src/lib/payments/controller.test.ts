import { describe, expect, it, vi } from 'vitest';
import {
	createPaymentController,
	MAX_SUMMARY_AGE_MS,
	type ControllerDeps,
	type PageState
} from './controller.js';
import { noticeCopy, STATUS_UNKNOWN_MESSAGE } from './copy.js';
import { paymentStore } from './checkout.js';
import { readPaymentSummary } from './contract.js';

const readSummary = (value: unknown) => readPaymentSummary(value);
import {
	bookedSummary,
	embeddedCheckout,
	embeddedSecret,
	openCheckout,
	otherToken,
	publicId,
	quotedSummary,
	token
} from './testing/fixtures.js';

function memoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => void map.set(key, String(value)),
		removeItem: (key) => void map.delete(key),
		clear: () => map.clear(),
		key: (index) => [...map.keys()][index] ?? null,
		get length() {
			return map.size;
		}
	};
}

type Settled = { status: number; body?: unknown; delayMs?: number } | 'network';
/** A plain reply, or a deferred one the test settles explicitly (deterministic ordering). */
type Reply = Settled | Promise<Settled>;

/** A reply whose completion the test controls. */
function deferred() {
	let settle!: (reply: Settled) => void;
	const promise = new Promise<Settled>((resolve) => (settle = resolve));
	return { promise, settle };
}

/** Lets pending promise callbacks (fetch → json → apply) run to completion. */
const flush = async () => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};
type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function harness(
	options: {
		hash?: string;
		search?: string;
		storage?: Storage | null;
		summary?: Reply[];
		checkout?: Reply[];
		uuids?: string[];
		pollDelays?: number[];
	} = {}
) {
	const storage = options.storage === undefined ? memoryStorage() : options.storage;
	const summaries = [...(options.summary ?? [])];
	const checkouts = [...(options.checkout ?? [])];
	const calls: Call[] = [];
	const states: PageState[] = [];
	const navigated: string[] = [];
	const uuids = [...(options.uuids ?? ['key-1', 'key-2', 'key-3'])];
	let cleared = 0;
	let visible = true;
	let clock = 1_000_000;
	let visibilityListener: (() => void) | null = null;
	const respond = async (pending: Reply | undefined): Promise<Response> => {
		const reply = await pending;
		if (!reply || reply === 'network') throw new TypeError('Failed to fetch');
		const response = new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
			status: reply.status,
			headers: { 'content-type': 'application/json' }
		});
		return reply.delayMs
			? new Promise<Response>((resolve) => setTimeout(() => resolve(response), reply.delayMs))
			: Promise.resolve(response);
	};
	const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({
			url,
			method: init?.method ?? 'GET',
			headers: Object.fromEntries(new Headers(init?.headers).entries()),
			body: init?.body as string | undefined
		});
		expect(init?.credentials).toBe('omit');
		return url.endsWith('/checkout-sessions')
			? respond(checkouts.length > 1 ? checkouts.shift() : checkouts[0])
			: respond(summaries.length > 1 ? summaries.shift() : summaries[0]);
	}) as unknown as typeof globalThis.fetch;
	const store = paymentStore(publicId, storage);
	const deps: ControllerDeps = {
		publicId,
		store,
		hash: options.hash ?? '',
		search: options.search ?? '',
		clearUrl: () => void cleared++,
		fetch,
		navigate: (url) => void navigated.push(url),
		uuid: () => uuids.shift() ?? 'key-x',
		visible: () => visible,
		onVisible(listener) {
			visibilityListener = listener;
			return () => (visibilityListener = null);
		},
		onState: (state) => void states.push(state),
		pollDelays: options.pollDelays ?? [1, 1, 1],
		retryDelays: [1, 1],
		now: () => clock
	};
	const controller = createPaymentController(deps);
	return {
		controller,
		store,
		storage,
		calls,
		navigated,
		states,
		get state() {
			return controller.state;
		},
		get cleared() {
			return cleared;
		},
		checkoutCalls: () => calls.filter((c) => c.url.endsWith('/checkout-sessions')),
		summaryCalls: () => calls.filter((c) => !c.url.endsWith('/checkout-sessions')),
		advance(ms: number) {
			clock += ms;
		},
		setVisible(value: boolean) {
			visible = value;
			visibilityListener?.();
		},
		replySummary(...replies: Reply[]) {
			summaries.splice(0, summaries.length, ...replies);
		},
		replyCheckout(...replies: Reply[]) {
			checkouts.splice(0, checkouts.length, ...replies);
		}
	};
}

const ok = (body: unknown) => ({ status: 200, body });

describe('bearer capture', () => {
	it('captures a fragment bearer into tab storage, cleans the URL and loads the summary', async () => {
		const h = harness({ hash: `#${token}`, summary: [ok(quotedSummary())] });
		await h.controller.start();
		expect(h.cleared).toBe(1);
		expect(h.store.token()).toBe(token);
		expect(h.storage!.getItem(`fionas.pay.${publicId}.token`)).toBe(token);
		const [read] = h.calls;
		expect(read.url).toBe(`/api/payments/${publicId}`);
		expect(read.url).not.toContain(token);
		expect(read.headers['x-fionas-payment-token']).toBe(token);
		expect(h.state.phase).toBe('ready');
		expect(h.state.view?.kind).toBe('deposit-due');
	});

	it('restores the bearer from this tab after a Stripe redirect', async () => {
		const storage = memoryStorage();
		paymentStore(publicId, storage).saveToken(token);
		const h = harness({ storage, search: '?checkout=returned', summary: [ok(quotedSummary())] });
		await h.controller.start();
		expect(h.cleared).toBe(1);
		expect(h.calls[0].headers['x-fionas-payment-token']).toBe(token);
	});

	it('replaces an older bearer when a newer link is opened', async () => {
		const storage = memoryStorage();
		paymentStore(publicId, storage).saveToken(otherToken);
		const h = harness({ storage, hash: `#${token}`, summary: [ok(quotedSummary())] });
		await h.controller.start();
		expect(h.store.token()).toBe(token);
	});

	it('asks for the original link when there is no bearer', async () => {
		const h = harness();
		await h.controller.start();
		expect(h.state.phase).toBe('link-required');
		expect(h.calls).toHaveLength(0);
	});

	it('refuses a malformed fragment without sending it anywhere', async () => {
		const h = harness({ hash: '#too-short' });
		await h.controller.start();
		expect(h.state.phase).toBe('link-incomplete');
		expect(h.cleared).toBe(1);
		expect(h.calls).toHaveLength(0);
	});

	it('forgets a revoked or rotated bearer', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [{ status: 404, body: { code: 'not_found' } }]
		});
		await h.controller.start();
		expect(h.state.phase).toBe('link-unavailable');
		expect(h.store.token()).toBeNull();
	});

	it('works for this page only when sessionStorage is unavailable', async () => {
		const h = harness({ hash: `#${token}`, storage: null, summary: [ok(quotedSummary())] });
		await h.controller.start();
		expect(h.state.persistent).toBe(false);
		expect(h.state.phase).toBe('ready');
	});

	it('distinguishes disabled payments from an unreachable backend', async () => {
		const disabled = harness({
			hash: `#${token}`,
			summary: [{ status: 503, body: { code: 'stripe_disabled' } }]
		});
		await disabled.controller.start();
		expect(disabled.state.phase).toBe('payments-disabled');
		const down = harness({ hash: `#${token}`, summary: ['network'] });
		await down.controller.start();
		expect(down.state.phase).toBe('unreachable');
	});
});

describe('starting checkout', () => {
	it('persists one key and the exact reviewed deposit body before sending, then redirects', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [ok(openCheckout)]
		});
		await h.controller.start();
		await h.controller.pay({ partialCents: null });
		const [post] = h.checkoutCalls();
		expect(post.method).toBe('POST');
		expect(post.headers['idempotency-key']).toBe('key-1');
		expect(post.body).toBe('{"expectedDocumentVersion":3,"expectedBusinessRevision":4}');
		expect(h.navigated).toEqual([openCheckout.url]);
		expect(h.state.busy).toBe('redirecting');
		expect(h.store.checkout()).toMatchObject({ key: 'key-1', phase: 'redirected' });
		// The hosted URL is a short-lived credential: never persisted.
		expect(JSON.stringify(h.store.checkout())).not.toContain('checkout.stripe.com');
	});

	it('never sends an amount for a deposit', async () => {
		const h = harness({ hash: `#${token}`, summary: [ok(quotedSummary())] });
		await h.controller.start();
		await h.controller.pay({ partialCents: 1000n });
		expect(h.checkoutCalls()).toHaveLength(0);
	});

	it('pays a full or partial Invoice amount in integer cents', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(bookedSummary())],
			checkout: [ok(openCheckout)]
		});
		await h.controller.start();
		await h.controller.pay({ partialCents: 10000n });
		expect(h.checkoutCalls()[0].body).toBe(
			'{"expectedDocumentVersion":6,"expectedBusinessRevision":8,"amountMinor":10000}'
		);
		const full = harness({
			hash: `#${token}`,
			summary: [ok(bookedSummary())],
			checkout: [ok(openCheckout)]
		});
		await full.controller.start();
		await full.controller.pay({ partialCents: null });
		expect(full.checkoutCalls()[0].body).toBe(
			'{"expectedDocumentVersion":6,"expectedBusinessRevision":8}'
		);
	});

	it('refuses amounts outside the balance or Stripe limits locally', async () => {
		const h = harness({ hash: `#${token}`, summary: [ok(bookedSummary())] });
		await h.controller.start();
		await h.controller.pay({ partialCents: 49n });
		await h.controller.pay({ partialCents: 96001n });
		expect(h.checkoutCalls()).toHaveLength(0);
	});

	it('sends one command for duplicate clicks', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [ok(openCheckout)]
		});
		await h.controller.start();
		await Promise.all([
			h.controller.pay({ partialCents: null }),
			h.controller.pay({ partialCents: null }),
			h.controller.pay({ partialCents: null })
		]);
		expect(h.checkoutCalls()).toHaveLength(1);
	});

	it('retries an ambiguous result with the same key and bytes, then holds it', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: ['network', { status: 502, body: { code: 'internal_failure' } }, 'network']
		});
		await h.controller.start();
		await h.controller.pay({ partialCents: null });
		const posts = h.checkoutCalls();
		expect(posts).toHaveLength(3);
		expect(new Set(posts.map((p) => p.headers['idempotency-key']))).toEqual(new Set(['key-1']));
		expect(new Set(posts.map((p) => p.body)).size).toBe(1);
		expect(h.state.notice).toBe('ambiguous');
		expect(h.state.pending).toMatchObject({ ambiguous: true, amountCents: 24000n });
		// A new Pay is refused while the outcome is unknown; Try again resends the same command.
		h.replyCheckout(ok(openCheckout));
		await h.controller.pay({ partialCents: null });
		expect(h.checkoutCalls()).toHaveLength(3);
		await h.controller.retry();
		expect(h.checkoutCalls().at(-1)?.headers['idempotency-key']).toBe('key-1');
		expect(h.navigated).toEqual([openCheckout.url]);
	});

	it('keeps an unknown outcome across a reload of the tab', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: ['network']
		});
		await h.controller.start();
		await h.controller.pay({ partialCents: null });
		const reloaded = harness({ storage: h.storage, summary: [ok(quotedSummary())] });
		await reloaded.controller.start();
		expect(reloaded.state.pending?.ambiguous).toBe(true);
		expect(reloaded.state.notice).toBe('ambiguous');
	});

	it('requires review after PAYMENT_TERMS_CHANGED and uses a new key next time', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [{ status: 409, body: { code: 'conflict', message: 'PAYMENT_TERMS_CHANGED' } }]
		});
		await h.controller.start();
		h.replySummary(
			ok(
				quotedSummary({
					requiredAmount: '300.00',
					document: { ...quotedSummary().document, version: 4, businessRevision: 5 }
				})
			)
		);
		await h.controller.pay({ partialCents: null });
		expect(h.state.notice).toBe('terms-changed');
		expect(h.store.checkout()).toBeNull();
		expect(h.state.view).toMatchObject({ kind: 'deposit-due', terms: { amountCents: 30000n } });
		h.replyCheckout(ok(openCheckout));
		await h.controller.pay({ partialCents: null });
		const last = h.checkoutCalls().at(-1)!;
		expect(last.headers['idempotency-key']).toBe('key-2');
		expect(last.body).toBe('{"expectedDocumentVersion":4,"expectedBusinessRevision":5}');
	});

	it('blocks CHECKOUT_KEY_REUSED until the customer deliberately starts over', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [{ status: 409, body: { code: 'conflict', message: 'CHECKOUT_KEY_REUSED' } }]
		});
		await h.controller.start();
		await h.controller.pay({ partialCents: null });
		expect(h.state.notice).toBe('key-reused');
		expect(h.state.pending?.blocked).toBe(true);
		await h.controller.retry();
		await h.controller.pay({ partialCents: null });
		expect(h.checkoutCalls()).toHaveLength(1);
		await h.controller.startOver();
		expect(h.store.checkout()).toBeNull();
		expect(h.state.pending).toBeNull();
	});

	it('fails closed on unknown conflict codes', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [{ status: 409, body: { code: 'brand_new_code' } }]
		});
		await h.controller.start();
		await h.controller.pay({ partialCents: null });
		expect(h.state.notice).toBe('refused');
		expect(h.navigated).toEqual([]);
	});

	it('does not follow a response that is not a Stripe Checkout URL', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [ok({ ...openCheckout, url: 'https://evil.example/pay' })]
		});
		await h.controller.start();
		h.replySummary(ok(quotedSummary({ paymentInProgress: true, canPay: false })));
		await h.controller.pay({ partialCents: null });
		expect(h.navigated).toEqual([]);
		expect(h.state.notice).toBe('checkout-open');
	});
});

describe('returning from Stripe', () => {
	async function redirected(summary: Record<string, unknown>, search: string) {
		const first = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [ok(openCheckout)]
		});
		await first.controller.start();
		await first.controller.pay({ partialCents: null });
		const back = harness({ storage: first.storage, search, summary: [ok(summary)] });
		await back.controller.start();
		return back;
	}

	it('confirms a deposit only from an authoritative BOOKED summary', async () => {
		const pending = await redirected(
			quotedSummary({ paymentInProgress: true, canPay: false }),
			'?checkout=returned'
		);
		expect(pending.state.notice).toBe('confirming');
		expect(pending.state.view?.kind).toBe('in-progress');
		const booked = await redirected(bookedSummary(), '?checkout=returned');
		expect(booked.state.notice).toBe('deposit-confirmed');
		expect(booked.store.checkout()).toBeNull();
	});

	it('never claims success from the return parameter alone', async () => {
		const back = await redirected(quotedSummary(), '?checkout=returned');
		expect(back.state.notice).toBe('checkout-not-completed');
		expect(back.state.view?.kind).toBe('deposit-due');
	});

	it('keeps a cancelled but still-open Checkout and resumes it with the same key', async () => {
		const back = await redirected(
			quotedSummary({ paymentInProgress: true, canPay: false, checkoutRecoveryAvailable: true }),
			'?checkout=cancelled'
		);
		expect(back.state.notice).toBe('checkout-cancelled-open');
		expect(back.store.checkout()?.key).toBe('key-1');
		back.replyCheckout(ok(openCheckout));
		await back.controller.recover({ partialCents: null });
		expect(back.checkoutCalls()[0].headers['idempotency-key']).toBe('key-1');
		expect(back.navigated).toEqual([openCheckout.url]);
	});

	it('polls with bounded backoff while a payment is confirming', async () => {
		const back = await redirected(
			quotedSummary({ paymentInProgress: true, canPay: false }),
			'?checkout=returned'
		);
		back.replySummary(ok(quotedSummary({ paymentInProgress: true, canPay: false })));
		await vi.waitFor(() => expect(back.state.polling).toBe('exhausted'));
		expect(back.summaryCalls()).toHaveLength(4); // the initial read plus three bounded polls
		back.replySummary(ok(bookedSummary()));
		await back.controller.refresh();
		expect(back.state.notice).toBe('deposit-confirmed');
		expect(back.state.polling).toBe('idle');
	});

	it('pauses polling while the page is hidden', async () => {
		const back = await redirected(
			quotedSummary({ paymentInProgress: true, canPay: false }),
			'?checkout=returned'
		);
		back.setVisible(false);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const hiddenReads = back.summaryCalls().length;
		expect(hiddenReads).toBeLessThanOrEqual(2);
		back.replySummary(ok(bookedSummary()));
		back.setVisible(true);
		await vi.waitFor(() => expect(back.state.notice).toBe('deposit-confirmed'));
	});

	it('confirms an Invoice payment with the authoritative remaining balance', async () => {
		const first = harness({
			hash: `#${token}`,
			summary: [ok(bookedSummary())],
			checkout: [ok(openCheckout)]
		});
		await first.controller.start();
		await first.controller.pay({ partialCents: 10000n });
		const back = harness({
			storage: first.storage,
			search: '?checkout=returned',
			summary: [
				ok(bookedSummary({ paidAmount: '340.00', balance: '860.00', requiredAmount: '860.00' }))
			]
		});
		await back.controller.start();
		expect(back.state.notice).toBe('payment-received');
		expect(back.state.view).toMatchObject({ kind: 'balance-due', terms: { amountCents: 86000n } });
	});
});

describe('recovery without the original browser', () => {
	const inProgress = quotedSummary({
		paymentInProgress: true,
		canPay: false,
		unavailableReason: 'PAYMENT_IN_PROGRESS',
		checkoutRecoveryAvailable: true
	});

	it('sends one deliberate fresh-key command and never loops on recovery conflicts', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(inProgress)],
			checkout: [{ status: 409, body: { code: 'checkout_in_progress' } }]
		});
		await h.controller.start();
		expect(h.state.view).toMatchObject({ kind: 'in-progress', recovery: { purpose: 'DEPOSIT' } });
		await h.controller.pay({ partialCents: null }); // the ordinary Pay is not available
		expect(h.checkoutCalls()).toHaveLength(0);
		await h.controller.recover({ partialCents: null });
		expect(h.checkoutCalls()).toHaveLength(1);
		expect(h.state.notice).toBe('checkout-open');
		expect(h.store.checkout()).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(h.checkoutCalls()).toHaveLength(1);
	});

	it('authorizes a replacement only when commerce confirms the old Session expired', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(inProgress)],
			checkout: [ok(openCheckout)]
		});
		await h.controller.start();
		await h.controller.recover({ partialCents: null });
		expect(h.checkoutCalls()[0].body).toBe(
			'{"expectedDocumentVersion":3,"expectedBusinessRevision":4}'
		);
		expect(h.navigated).toEqual([openCheckout.url]);
	});

	it.each([
		['payment_processing', 'processing'],
		['payment_state_changed', 'state-changed'],
		['checkout_recovery_conflict', 'recovery-conflict'],
		['checkout_reconciliation_required', 'reconciliation-required']
	])('maps %s without authorizing anything', async (code, notice) => {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(inProgress)],
			checkout: [{ status: 409, body: { code } }]
		});
		await h.controller.start();
		await h.controller.recover({ partialCents: null });
		expect(h.state.notice).toBe(notice);
		expect(h.navigated).toEqual([]);
		expect(h.store.checkout()).toBeNull();
	});

	it('never reports an in-flight recovery as an unknown outcome when a poll lands mid-send', async () => {
		// The checkout answer is held until the test releases it, so a poll always lands mid-send.
		const held = deferred();
		const h = harness({ hash: `#${token}`, summary: [ok(inProgress)], checkout: [held.promise] });
		await h.controller.start();
		const notices: unknown[] = [];
		const recovery = h.controller.recover({ partialCents: null });
		await vi.waitFor(() => expect(h.summaryCalls().length).toBeGreaterThan(1));
		await flush();
		notices.push(h.state.notice, h.state.pending?.ambiguous);
		held.settle(ok(openCheckout));
		await recovery;
		expect(notices).toEqual([null, false]);
		expect(h.navigated).toEqual([openCheckout.url]);
	});

	it('treats a historical EXPIRED replay as terminal, not as a new authorization', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [ok({ ...openCheckout, url: undefined, state: 'EXPIRED', outcome: 'PENDING' })]
		});
		await h.controller.start();
		await h.controller.pay({ partialCents: null });
		expect(h.state.notice).toBe('checkout-expired');
		expect(h.store.checkout()).toBeNull();
		expect(h.navigated).toEqual([]);
	});
});

describe('payment status certainty', () => {
	it('does not treat disabled payments as uncertain before any checkout', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [{ status: 503, body: { code: 'stripe_disabled' } }]
		});
		await h.controller.start();
		expect(h.state.phase).toBe('payments-disabled');
		expect(h.state.paymentUncertain).toBe(false);
	});

	it('keeps an ambiguous command, and its uncertainty, when payments become disabled', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: ['network', { status: 503, body: { code: 'stripe_disabled' } }]
		});
		await h.controller.start();
		h.replySummary({ status: 503, body: { code: 'stripe_disabled' } });
		await h.controller.pay({ partialCents: null });
		expect(h.state.phase).toBe('payments-disabled');
		expect(h.store.checkout()?.key).toBe('key-1');
		expect(h.state.paymentUncertain).toBe(true);
	});

	it('discards a brand-new command refused at once because payments are disabled', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [{ status: 503, body: { code: 'stripe_disabled' } }]
		});
		await h.controller.start();
		await h.controller.pay({ partialCents: null });
		expect(h.state.phase).toBe('payments-disabled');
		expect(h.store.checkout()).toBeNull();
		expect(h.state.paymentUncertain).toBe(false);
	});

	async function afterRedirect(search: string, summary: Reply) {
		const first = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [ok(openCheckout)]
		});
		await first.controller.start();
		await first.controller.pay({ partialCents: null });
		const back = harness({ storage: first.storage, search, summary: [summary] });
		await back.controller.start();
		return back;
	}

	it('is uncertain when the backend is unavailable after returning from Stripe', async () => {
		for (const search of ['?checkout=returned', '?checkout=cancelled']) {
			const down = await afterRedirect(search, 'network');
			expect(down.state.phase).toBe('unreachable');
			expect(down.state.paymentUncertain).toBe(true);
			const disabled = await afterRedirect(search, {
				status: 503,
				body: { code: 'stripe_disabled' }
			});
			expect(disabled.state.phase).toBe('payments-disabled');
			expect(disabled.state.paymentUncertain).toBe(true);
			expect(disabled.store.checkout()?.phase).toBe('redirected');
		}
	});

	it('is uncertain for a command persisted by an earlier page load', async () => {
		const first = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: ['network']
		});
		await first.controller.start();
		await first.controller.pay({ partialCents: null });
		const later = harness({ storage: first.storage, summary: ['network'] });
		await later.controller.start();
		expect(later.state.phase).toBe('unreachable');
		expect(later.state.paymentUncertain).toBe(true);
	});

	it('keeps the uncertainty when a revoked link drops a pending checkout', async () => {
		const back = await afterRedirect('?checkout=returned', {
			status: 404,
			body: { code: 'not_found' }
		});
		expect(back.state.phase).toBe('link-unavailable');
		expect(back.state.paymentUncertain).toBe(true);
	});

	it('settles uncertainty only from an authoritative summary', async () => {
		const back = await afterRedirect('?checkout=cancelled', ok(quotedSummary()));
		expect(back.state.notice).toBe('checkout-not-completed');
		expect(back.state.paymentUncertain).toBe(false);
	});

	it('never words an unknown outcome as success or as nothing charged', () => {
		const summary = readSummary(quotedSummary());
		for (const kind of [
			'refresh-failed',
			'ambiguous',
			'checkout-not-completed',
			'checkout-cancelled-open',
			'confirming',
			'checkout-open',
			'processing'
		] as const) {
			const copy = noticeCopy(kind, summary, true);
			const text = `${copy.title} ${copy.body}`;
			expect(text).not.toMatch(
				/(haven't|have not|not) been charged|weren't charged|won't be charged|no payment was taken|payment received|deposit received|booking is confirmed/i
			);
		}
		expect(noticeCopy('refresh-failed', summary, true).body).toContain(STATUS_UNKNOWN_MESSAGE);
	});
});

describe('summary freshness', () => {
	it('blocks a new payment against a summary kept after a failed refresh', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [ok(openCheckout)]
		});
		await h.controller.start();
		expect(h.state.summaryFresh).toBe(true);
		h.replySummary('network');
		await h.controller.refresh();
		expect(h.state.summary).not.toBeNull(); // still shown
		expect(h.state.view?.kind).toBe('deposit-due');
		expect(h.state.summaryFresh).toBe(false);
		await h.controller.pay({ partialCents: null });
		expect(h.checkoutCalls()).toHaveLength(0);
		h.replySummary(ok(quotedSummary()));
		await h.controller.refresh();
		expect(h.state.summaryFresh).toBe(true);
		await h.controller.pay({ partialCents: null });
		expect(h.checkoutCalls()).toHaveLength(1);
	});

	it('re-reads an old summary before paying and proceeds when the terms are unchanged', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [ok(openCheckout)]
		});
		await h.controller.start();
		h.advance(MAX_SUMMARY_AGE_MS + 1);
		await h.controller.pay({ partialCents: null });
		expect(h.summaryCalls()).toHaveLength(2);
		expect(h.checkoutCalls()).toHaveLength(1);
	});

	it('stops for review when an old summary turns out to have changed', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [ok(openCheckout)]
		});
		await h.controller.start();
		h.advance(MAX_SUMMARY_AGE_MS + 1);
		h.replySummary(
			ok(
				quotedSummary({
					requiredAmount: '300.00',
					document: { ...quotedSummary().document, version: 4, businessRevision: 5 }
				})
			)
		);
		await h.controller.pay({ partialCents: null });
		expect(h.checkoutCalls()).toHaveLength(0);
		expect(h.state.notice).toBe('terms-changed');
		expect(h.state.view).toMatchObject({ terms: { amountCents: 30000n } });
	});

	it('refuses when the pre-payment re-read fails', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [ok(openCheckout)]
		});
		await h.controller.start();
		h.advance(MAX_SUMMARY_AGE_MS + 1);
		h.replySummary('network');
		await h.controller.pay({ partialCents: null });
		expect(h.checkoutCalls()).toHaveLength(0);
		expect(h.state.summaryFresh).toBe(false);
	});

	it("gates fresh-key recovery but always allows resending this tab's own command", async () => {
		const inProgress = quotedSummary({
			paymentInProgress: true,
			canPay: false,
			unavailableReason: 'PAYMENT_IN_PROGRESS',
			checkoutRecoveryAvailable: true
		});
		const h = harness({
			hash: `#${token}`,
			summary: [ok(inProgress)],
			checkout: [ok(openCheckout)]
		});
		await h.controller.start();
		h.replySummary('network');
		await h.controller.refresh();
		await h.controller.recover({ partialCents: null });
		expect(h.checkoutCalls()).toHaveLength(0);

		const first = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [ok(openCheckout)]
		});
		await first.controller.start();
		await first.controller.pay({ partialCents: null });
		const back = harness({
			storage: first.storage,
			search: '?checkout=cancelled',
			summary: [ok(inProgress)],
			checkout: [ok(openCheckout)]
		});
		await back.controller.start();
		back.replySummary('network');
		await back.controller.refresh();
		await back.controller.recover({ partialCents: null });
		expect(back.checkoutCalls()[0].headers['idempotency-key']).toBe('key-1');
	});

	it('allows the same-key retry of an ambiguous command without a fresh summary', async () => {
		const h = harness({ hash: `#${token}`, summary: [ok(quotedSummary())], checkout: ['network'] });
		await h.controller.start();
		h.replySummary('network');
		await h.controller.pay({ partialCents: null });
		expect(h.state.summaryFresh).toBe(false);
		h.replyCheckout(ok(openCheckout));
		await h.controller.retry();
		expect(h.checkoutCalls().at(-1)?.headers['idempotency-key']).toBe('key-1');
		expect(h.navigated).toEqual([openCheckout.url]);
	});
});

describe('summary request ordering', () => {
	const quoteV4 = () =>
		quotedSummary({
			requiredAmount: '300.00',
			document: { ...quotedSummary().document, version: 4, businessRevision: 5 }
		});
	/** A started page whose next two summary reads are A (older) and B (newer). */
	async function overlapping(initial: Record<string, unknown> = quotedSummary(), extra = {}) {
		const a = deferred();
		const b = deferred();
		const h = harness({
			hash: `#${token}`,
			summary: [ok(initial)],
			checkout: [ok(openCheckout)],
			pollDelays: [60_000],
			...extra
		});
		await h.controller.start();
		h.replySummary(a.promise, b.promise, 'network');
		const reads = [h.controller.refresh(), h.controller.refresh()];
		await flush();
		return { h, a, b, done: () => Promise.all(reads) };
	}

	it('A: an older success arriving last cannot overwrite the newer one', async () => {
		const { h, a, b, done } = await overlapping();
		b.settle(ok(quoteV4()));
		await flush();
		a.settle(ok(quotedSummary()));
		await done();
		expect(h.state.summary?.document).toMatchObject({ version: 4, businessRevision: 5 });
		expect(h.state.view).toMatchObject({ terms: { documentVersion: 4, amountCents: 30000n } });
		expect(h.state.summaryFresh).toBe(true);
	});

	it('B: an older failure arriving last cannot mark a newer success stale', async () => {
		const { h, a, b, done } = await overlapping();
		b.settle(ok(quoteV4()));
		await flush();
		a.settle('network');
		await done();
		expect(h.state.summaryFresh).toBe(true);
		expect(h.state.notice).toBeNull();
	});

	it('C: an older 404 cannot revoke the bearer or drop a stored command', async () => {
		const { h, a, b, done } = await overlapping();
		const stored = {
			key: 'kept-key',
			command: { expectedDocumentVersion: 3, expectedBusinessRevision: 4 },
			purpose: 'DEPOSIT' as const,
			amountCents: '24000',
			paidBefore: '0.00',
			lifecycleBefore: 'QUOTED',
			phase: 'redirected' as const
		};
		h.store.saveCheckout(stored);
		b.settle(ok(quotedSummary({ paymentInProgress: true, canPay: false })));
		await flush();
		a.settle({ status: 404, body: { code: 'not_found' } });
		await done();
		expect(h.state.phase).toBe('ready');
		expect(h.store.token()).toBe(token);
		expect(h.store.checkout()).toEqual(stored);
	});

	it('D: an older stripe_disabled cannot disable a newer valid state', async () => {
		const { h, a, b, done } = await overlapping();
		b.settle(ok(quotedSummary()));
		await flush();
		a.settle({ status: 503, body: { code: 'stripe_disabled' } });
		await done();
		expect(h.state.phase).toBe('ready');
		expect(h.state.view?.kind).toBe('deposit-due');
	});

	it('E: an older success cannot restore eligibility after a newer failure', async () => {
		const { h, a, b, done } = await overlapping();
		b.settle('network');
		await flush();
		a.settle(ok(quotedSummary()));
		await done();
		expect(h.state.summaryFresh).toBe(false);
		await h.controller.pay({ partialCents: null });
		expect(h.checkoutCalls()).toHaveLength(0);
		h.replySummary(ok(quotedSummary()));
		await h.controller.refresh();
		expect(h.state.summaryFresh).toBe(true);
	});

	it('F: a confirmed deposit cannot regress to pending by response order', async () => {
		const first = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [ok(openCheckout)]
		});
		await first.controller.start();
		await first.controller.pay({ partialCents: null });
		const { h, a, b, done } = await overlapping(
			quotedSummary({ paymentInProgress: true, canPay: false }),
			{ storage: first.storage, hash: '', search: '?checkout=returned' }
		);
		expect(h.state.notice).toBe('confirming');
		b.settle(ok(bookedSummary()));
		await flush();
		a.settle(ok(quotedSummary({ paymentInProgress: true, canPay: false })));
		await done();
		expect(h.state.summary?.lifecycle).toBe('BOOKED');
		expect(h.state.notice).toBe('deposit-confirmed');
		expect(h.state.view?.kind).toBe('balance-due');
		expect(h.state.polling).toBe('idle');
	});

	it('G: a pre-payment check cannot authorize superseded terms', async () => {
		const a = deferred();
		const b = deferred();
		const h = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [ok(openCheckout)]
		});
		await h.controller.start();
		h.advance(MAX_SUMMARY_AGE_MS + 1);
		h.replySummary(a.promise, b.promise, 'network');
		const paying = h.controller.pay({ partialCents: null }); // re-reads (A)
		await flush();
		const competing = h.controller.refresh(); // B supersedes A
		await flush();
		b.settle(ok(quoteV4()));
		await flush();
		a.settle(ok(quotedSummary())); // the old terms, arriving last
		await Promise.all([paying, competing]);
		expect(h.checkoutCalls()).toHaveLength(0);
		expect(h.state.notice).toBe('terms-changed');
		expect(h.state.view).toMatchObject({ terms: { amountCents: 30000n, documentVersion: 4 } });
		// A deliberate second click uses the reviewed new terms.
		await h.controller.pay({ partialCents: null });
		expect(h.checkoutCalls()[0].body).toBe(
			'{"expectedDocumentVersion":4,"expectedBusinessRevision":5}'
		);
	});

	it('G2: a pre-payment check never decides while a newer read is still pending', async () => {
		const a = deferred();
		const b = deferred();
		const h = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [ok(openCheckout)]
		});
		await h.controller.start();
		h.advance(MAX_SUMMARY_AGE_MS + 1);
		h.replySummary(a.promise, b.promise, 'network');
		const paying = h.controller.pay({ partialCents: null });
		await flush();
		const competing = h.controller.refresh();
		await flush();
		a.settle(ok(quotedSummary()));
		await flush();
		expect(h.checkoutCalls()).toHaveLength(0); // still waiting for B
		b.settle(ok(quotedSummary()));
		await Promise.all([paying, competing]);
		// Unchanged terms from the latest read: the same click proceeds, once.
		expect(h.checkoutCalls()).toHaveLength(1);
	});

	it('H: superseded and failed reads never touch an ambiguous command; retry reuses it', async () => {
		const h = harness({ hash: `#${token}`, summary: [ok(quotedSummary())], checkout: ['network'] });
		await h.controller.start();
		await h.controller.pay({ partialCents: null });
		const saved = h.store.checkout();
		expect(saved?.phase).toBe('sending');
		const a = deferred();
		const b = deferred();
		h.replySummary(a.promise, b.promise, 'network');
		const reads = [h.controller.refresh(), h.controller.refresh()];
		await flush();
		b.settle('network');
		await flush();
		a.settle({ status: 404, body: { code: 'not_found' } });
		await Promise.all(reads);
		expect(h.store.checkout()).toEqual(saved);
		expect(h.store.token()).toBe(token);
		h.replyCheckout(ok(openCheckout));
		await h.controller.retry();
		const last = h.checkoutCalls().at(-1)!;
		expect(last.headers['idempotency-key']).toBe(saved!.key);
		expect(last.body).toBe('{"expectedDocumentVersion":3,"expectedBusinessRevision":4}');
		expect(h.navigated).toEqual([openCheckout.url]);
	});

	it('I: a disposed controller ignores a read that completes later', async () => {
		const a = deferred();
		const h = harness({ hash: `#${token}`, summary: [ok(quotedSummary())] });
		await h.controller.start();
		h.replySummary(a.promise);
		const read = h.controller.refresh();
		await flush();
		h.controller.dispose();
		const emitted = h.states.length;
		a.settle({ status: 404, body: { code: 'not_found' } });
		await read;
		expect(h.states).toHaveLength(emitted);
		expect(h.store.token()).toBe(token);
	});

	it('J: a superseded completion keeps loading and never restarts settled polling', async () => {
		const pending = quotedSummary({ paymentInProgress: true, canPay: false });
		const { h, a, b, done } = await overlapping(pending);
		expect(h.state.polling).toBe('active');
		expect(h.state.busy).toBe('refreshing');
		a.settle(ok(pending)); // older completes first but is already superseded
		await flush();
		expect(h.state.busy).toBe('refreshing');
		b.settle(ok(bookedSummary()));
		await done();
		expect(h.state.busy).toBeNull();
		expect(h.state.polling).toBe('idle');
		const reads = h.summaryCalls().length;
		await flush();
		expect(h.summaryCalls()).toHaveLength(reads);
	});
});

describe('embedded Checkout', () => {
	const underway = (summary: Record<string, unknown>) => ({
		...summary,
		paymentInProgress: true,
		canPay: false,
		unavailableReason: 'PAYMENT_IN_PROGRESS',
		checkoutRecoveryAvailable: true
	});
	const quotedUnderway = underway(quotedSummary());
	const depositBody = '{"expectedDocumentVersion":3,"expectedBusinessRevision":4}';
	const json = (value: unknown) =>
		JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));

	/** Everything this tab could persist, emit or send: the secret must appear in none of it. */
	function exposure(h: ReturnType<typeof harness>) {
		const stored: string[] = [];
		for (let i = 0; i < (h.storage?.length ?? 0); i++)
			stored.push(h.storage!.getItem(h.storage!.key(i)!) ?? '');
		return json({ states: h.states, stored, calls: h.calls, navigated: h.navigated });
	}

	async function opened(options: Parameters<typeof harness>[0] = {}) {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [ok(embeddedCheckout)],
			pollDelays: [60_000],
			...options
		});
		await h.controller.start();
		h.replySummary(ok(quotedUnderway));
		await h.controller.pay({ partialCents: null });
		return h;
	}

	it('B: mounts in place, keeping the client secret in memory only', async () => {
		const h = await opened();
		expect(h.navigated).toEqual([]);
		expect(h.state.busy).toBeNull();
		expect(h.state.notice).toBeNull(); // nothing has been paid: never "confirming" here
		expect(h.state.embedded).toMatchObject({
			attemptId: embeddedCheckout.attemptId,
			purpose: 'DEPOSIT',
			amountCents: 24000n,
			businessRevision: 4
		});
		await expect(h.state.embedded!.clientSecret()).resolves.toBe(embeddedSecret);
		expect(h.store.checkout()).toMatchObject({
			key: 'key-1',
			phase: 'redirected',
			uiMode: 'EMBEDDED'
		});
		expect(exposure(h)).not.toContain(embeddedSecret);
		expect(Object.values(h.state.embedded!)).not.toContain(embeddedSecret);
		expect(h.state.view?.kind).toBe('in-progress');
		expect(h.state.paymentUncertain).toBe(true);
	});

	it('E: clicks, recovery and retries never authorize again while the form is open', async () => {
		const h = await opened();
		const launch = h.state.embedded;
		await Promise.all([
			h.controller.pay({ partialCents: null }),
			h.controller.recover({ partialCents: null }),
			h.controller.retry(),
			h.controller.refresh()
		]);
		expect(h.checkoutCalls()).toHaveLength(1);
		expect(h.state.embedded).toBe(launch);
	});

	it('closing keeps the command and Session; continuing resends the same key and body', async () => {
		const h = await opened();
		const first = h.state.embedded!;
		h.controller.closeEmbedded();
		await flush();
		expect(h.state.embedded).toBeNull();
		expect(h.state.notice).toBe('embedded-closed');
		await expect(first.clientSecret()).rejects.toThrow();
		expect(h.store.checkout()).toMatchObject({ key: 'key-1', uiMode: 'EMBEDDED' });
		expect(h.state.pending).toMatchObject({ uiMode: 'EMBEDDED', completing: false });
		await h.controller.pay({ partialCents: null });
		expect(h.checkoutCalls()).toHaveLength(1); // the ordinary Pay stays closed
		await h.controller.recover({ partialCents: null });
		const [one, two] = h.checkoutCalls();
		expect(two.headers['idempotency-key']).toBe(one.headers['idempotency-key']);
		expect(two.body).toBe(one.body);
		expect(h.state.embedded?.id).not.toBe(first.id);
		await expect(h.state.embedded!.clientSecret()).resolves.toBe(embeddedSecret);
	});

	it('F: after a reload, the saved command reacquires the same Session, never a new one', async () => {
		const first = await opened();
		first.controller.dispose();
		const back = harness({
			storage: first.storage,
			summary: [ok(quotedUnderway)],
			checkout: [ok(embeddedCheckout)],
			pollDelays: [60_000]
		});
		await back.controller.start();
		expect(back.state.embedded).toBeNull(); // the secret did not survive the reload
		expect(back.state.notice).toBe('embedded-closed');
		expect(noticeCopy('embedded-closed', null).body).not.toMatch(/charged|no charge|not paid/i);
		await back.controller.recover({ partialCents: null });
		expect(back.checkoutCalls()).toHaveLength(1);
		expect(back.checkoutCalls()[0].headers['idempotency-key']).toBe('key-1');
		expect(back.checkoutCalls()[0].body).toBe(depositBody);
		expect(back.state.embedded?.attemptId).toBe(embeddedCheckout.attemptId);
		expect(exposure(back)).not.toContain(embeddedSecret);
	});

	it('G: each attempt launches by its own mode, whatever commerce is configured for now', async () => {
		// An embedded attempt stays embedded after commerce switches back to hosted...
		const embedded = await opened();
		embedded.controller.closeEmbedded();
		await flush();
		await embedded.controller.recover({ partialCents: null });
		expect(embedded.navigated).toEqual([]);
		expect(embedded.state.embedded).not.toBeNull();
		// ...and a hosted attempt stays hosted after embedded mode is enabled.
		const hosted = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [ok(openCheckout)]
		});
		await hosted.controller.start();
		await hosted.controller.pay({ partialCents: null });
		const back = harness({
			storage: hosted.storage,
			search: '?checkout=cancelled',
			summary: [ok(quotedUnderway)],
			checkout: [ok(openCheckout)]
		});
		await back.controller.start();
		expect(back.state.notice).toBe('checkout-cancelled-open');
		await back.controller.recover({ partialCents: null });
		expect(back.navigated).toEqual([openCheckout.url]);
		expect(back.state.embedded).toBeNull();
		expect(back.store.checkout()?.uiMode).toBe('HOSTED');
	});

	it('reads commands saved by the release before presentation modes', async () => {
		const storage = memoryStorage();
		storage.setItem(
			`fionas.pay.${publicId}.checkout`,
			JSON.stringify({
				key: 'old-key',
				command: { expectedDocumentVersion: 3, expectedBusinessRevision: 4 },
				purpose: 'DEPOSIT',
				amountCents: '24000',
				paidBefore: '0.00',
				lifecycleBefore: 'QUOTED',
				phase: 'redirected'
			})
		);
		storage.setItem(`fionas.pay.${publicId}.token`, token);
		const h = harness({ storage, summary: [ok(quotedUnderway)], pollDelays: [60_000] });
		await h.controller.start();
		expect(h.state.notice).toBe('confirming'); // hosted wording, exactly as before
		expect(h.state.pending).toMatchObject({ uiMode: null, completing: false });
	});

	it('H: completion starts an authoritative refresh and never claims success itself', async () => {
		const h = await opened();
		const launch = h.state.embedded!;
		const reads = h.summaryCalls().length;
		h.controller.embeddedComplete(launch.id + 1); // a stale launch callback is ignored
		expect(h.state.embedded).toBe(launch);
		h.controller.embeddedComplete(launch.id);
		expect(h.state.embedded).toBeNull();
		expect(h.state.notice).toBe('confirming');
		await expect(launch.clientSecret()).rejects.toThrow();
		expect(h.store.checkout()).toMatchObject({ key: 'key-1', completing: true });
		await flush();
		expect(h.summaryCalls().length).toBe(reads + 1);
		expect(h.states.some((s) => s.notice === 'deposit-confirmed')).toBe(false);
		expect(h.state.pending?.completing).toBe(true);
	});

	it('I: a pending summary after completion keeps polling and keeps payment closed', async () => {
		const h = await opened({ pollDelays: [1, 1, 1] });
		h.controller.embeddedComplete(h.state.embedded!.id);
		await vi.waitFor(() => expect(h.state.polling).toBe('exhausted'));
		expect(h.state.notice).toBe('confirming');
		expect(h.state.view?.kind).toBe('in-progress');
		await h.controller.pay({ partialCents: null });
		await h.controller.recover({ partialCents: null }); // only its own command, same key
		expect(new Set(h.checkoutCalls().map((c) => c.headers['idempotency-key']))).toEqual(
			new Set(['key-1'])
		);
	});

	it('J: an authoritative BOOKED summary confirms the deposit and clears the form', async () => {
		const h = await opened();
		h.replySummary(ok(bookedSummary()));
		h.controller.embeddedComplete(h.state.embedded!.id);
		await flush();
		expect(h.state.notice).toBe('deposit-confirmed');
		expect(h.state.embedded).toBeNull();
		expect(h.store.checkout()).toBeNull();
		expect(h.state.view?.kind).toBe('balance-due');
		expect(noticeCopy('deposit-confirmed', h.state.summary).body).toContain('$960.00');
	});

	it('K: a partial Invoice payment shows the new balance; the next one is a new decision', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(bookedSummary())],
			checkout: [ok(embeddedCheckout)],
			pollDelays: [60_000]
		});
		await h.controller.start();
		h.replySummary(ok(underway(bookedSummary())));
		await h.controller.pay({ partialCents: 10000n });
		expect(h.checkoutCalls()[0].body).toBe(
			'{"expectedDocumentVersion":6,"expectedBusinessRevision":8,"amountMinor":10000}'
		);
		expect(h.state.embedded).toMatchObject({ purpose: 'INVOICE', amountCents: 10000n });
		h.replySummary(
			ok(bookedSummary({ paidAmount: '340.00', balance: '860.00', requiredAmount: '860.00' }))
		);
		h.controller.embeddedComplete(h.state.embedded!.id);
		await flush();
		expect(h.state.notice).toBe('payment-received');
		expect(noticeCopy('payment-received', h.state.summary).body).toBe(
			'Your remaining balance is $860.00.'
		);
		expect(h.state.view).toMatchObject({ kind: 'balance-due', terms: { amountCents: 86000n } });
		expect(h.checkoutCalls()).toHaveLength(1); // nothing started on its own
		h.replyCheckout(ok({ ...embeddedCheckout, attemptId: '0e7d1c8a-3b2f-4a5e-8c9d-1f2e3d4c5b6a' }));
		await h.controller.pay({ partialCents: null });
		expect(h.checkoutCalls()[1].headers['idempotency-key']).toBe('key-2');
	});

	it('removes the form when commerce no longer shows the attempt underway', async () => {
		const h = await opened();
		const launch = h.state.embedded!;
		h.replySummary(ok(quotedSummary({ document: { ...quotedSummary().document, version: 5 } })));
		await h.controller.refresh();
		expect(h.state.embedded).toBeNull();
		await expect(launch.clientSecret()).rejects.toThrow();
		expect(h.state.notice).toBe('checkout-not-completed');
		expect(h.store.checkout()).toBeNull();
		expect(h.checkoutCalls()).toHaveLength(1); // never replaced automatically
	});

	it('drops the form with a revoked link or disabled payments', async () => {
		const revoked = await opened();
		revoked.replySummary({ status: 404, body: { code: 'not_found' } });
		await revoked.controller.refresh();
		expect(revoked.state.phase).toBe('link-unavailable');
		expect(revoked.state.embedded).toBeNull();
		expect(revoked.state.paymentUncertain).toBe(true);
		const disabled = await opened();
		disabled.replySummary({ status: 503, body: { code: 'stripe_disabled' } });
		await disabled.controller.refresh();
		expect(disabled.state.phase).toBe('payments-disabled');
		expect(disabled.state.embedded).toBeNull();
		expect(disabled.store.checkout()?.key).toBe('key-1');
	});

	it('keeps the form through a failed refresh, which Stripe does not depend on', async () => {
		const h = await opened();
		h.replySummary('network');
		await h.controller.refresh();
		expect(h.state.notice).toBe('refresh-failed');
		expect(h.state.embedded).not.toBeNull();
	});

	it('never launches from a terminal answer or an unknown mode', async () => {
		const terminal = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [ok({ ...embeddedCheckout, state: 'EXPIRED' })]
		});
		await terminal.controller.start();
		await terminal.controller.pay({ partialCents: null });
		expect(terminal.state.embedded).toBeNull();
		expect(terminal.state.notice).toBe('checkout-expired');
		const unknown = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [ok({ ...embeddedCheckout, uiMode: 'POPUP' })]
		});
		await unknown.controller.start();
		await unknown.controller.pay({ partialCents: null });
		expect(unknown.state.embedded).toBeNull();
		expect(unknown.navigated).toEqual([]);
		// Fail closed, keeping the command: only the same key may be retried.
		expect(unknown.state.notice).toBe('ambiguous');
		expect(unknown.store.checkout()).toMatchObject({ key: 'key-1', phase: 'sending' });
		expect(exposure(unknown)).not.toContain(embeddedSecret);
	});

	it('forgets the secret when the page goes away', async () => {
		const h = await opened();
		const launch = h.state.embedded!;
		h.controller.dispose();
		await expect(launch.clientSecret()).rejects.toThrow();
	});
});
