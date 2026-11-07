import { describe, expect, it, vi } from 'vitest';
import {
	authorizationMatches,
	createPaymentController,
	MAX_SUMMARY_AGE_MS,
	type ControllerDeps,
	type PageState
} from './controller.js';
import { noticeCopy, STATUS_UNKNOWN_MESSAGE } from './copy.js';
import { paymentStore, type StoredCheckout } from './checkout.js';
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
	restartEligible,
	restartToken,
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
		setTimer?: ControllerDeps['setTimer'];
		clearTimer?: ControllerDeps['clearTimer'];
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
		setTimer: options.setTimer,
		clearTimer: options.clearTimer,
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

describe('deliberate checkout restart', () => {
	const invoice = bookedSummary(restartEligible);
	const deposit = quotedSummary(restartEligible);
	const allDue = { partialCents: null };
	const partial = { partialCents: 15000n };
	const replacedAttemptId = '99ba495c-4747-4dc4-87ed-69357de3cba9';
	const review = (h: ReturnType<typeof harness>) => {
		const view = h.state.view;
		if (view?.kind !== 'in-progress' || !view.restart) throw new Error('No restart review');
		return view.restart;
	};
	const setup = (options: Parameters<typeof harness>[0] = {}) =>
		harness({ hash: `#${token}`, summary: [ok(invoice)], pollDelays: [], ...options });

	it.each(['HOSTED', 'EMBEDDED', 'ELEMENTS'] as const)(
		'launches a %s replacement with the new Invoice amount and a fresh key',
		async (mode) => {
			const response = mode === 'HOSTED' ? openCheckout : { ...embeddedCheckout, uiMode: mode };
			const h = setup({ checkout: [ok({ ...response, replacedAttemptId })] });
			h.store.saveCheckout({
				key: 'original',
				command: { expectedDocumentVersion: 6, expectedBusinessRevision: 8, amountMinor: 25000 },
				purpose: 'INVOICE',
				amountCents: '25000',
				paidBefore: '240.00',
				lifecycleBefore: 'BOOKED',
				phase: 'redirected',
				uiMode: 'ELEMENTS',
				attemptId: replacedAttemptId
			});
			await h.controller.start();
			await h.controller.pay(partial);
			expect(h.checkoutCalls()).toHaveLength(0);
			await h.controller.restart(review(h), partial);
			expect(h.checkoutCalls()[0]).toMatchObject({
				headers: { 'idempotency-key': 'key-1' },
				body: `{"expectedDocumentVersion":6,"expectedBusinessRevision":8,"amountMinor":15000,"restartToken":"${restartToken}"}`
			});
			expect(h.store.checkout()).toMatchObject({ key: 'key-1', amountCents: '15000' });
			if (mode === 'HOSTED') expect(h.navigated).toEqual([openCheckout.url]);
			else {
				expect(h.state.checkout).toMatchObject({
					mode,
					attemptId: response.attemptId,
					amountCents: 15000n
				});
				expect(await h.state.checkout?.clientSecret()).toBe(embeddedSecret);
			}
			expect(JSON.stringify(h.store.checkout())).not.toContain(embeddedSecret);
			h.controller.dispose();
		}
	);

	it('restarts a deposit without an amount and coalesces repeated submits', async () => {
		const h = setup({ summary: [ok(deposit)], checkout: [ok(openCheckout)] });
		await h.controller.start();
		const reviewed = review(h);
		await h.controller.restart(reviewed, partial);
		expect(h.checkoutCalls()).toHaveLength(0);
		await Promise.all([
			h.controller.restart(reviewed, allDue),
			h.controller.restart(reviewed, allDue)
		]);
		expect(h.checkoutCalls()).toHaveLength(1);
		expect(JSON.parse(h.checkoutCalls()[0].body!)).toEqual({
			expectedDocumentVersion: 3,
			expectedBusinessRevision: 4,
			restartToken
		});
	});

	it('requires a permitted partial amount when the full Invoice balance exceeds Stripe limits', async () => {
		const h = setup({
			summary: [ok({ ...invoice, balance: '1200000.00', requiredAmount: '1200000.00' })],
			checkout: [ok(openCheckout)]
		});
		await h.controller.start();
		for (const choice of [allDue, { partialCents: 49n }, { partialCents: 100_000_000n }])
			await h.controller.restart(review(h), choice);
		expect(h.checkoutCalls()).toHaveLength(0);
		await h.controller.restart(review(h), { partialCents: 50n });
		expect(JSON.parse(h.checkoutCalls()[0].body!).amountMinor).toBe(50);
	});

	it('binds a full Invoice restart to the exact reviewed cents', async () => {
		const h = setup({ checkout: [ok(openCheckout)] });
		await h.controller.start();
		await h.controller.restart(review(h), allDue);
		expect(JSON.parse(h.checkoutCalls()[0].body!).amountMinor).toBe(96000);
	});

	it.each([
		[404, 'not_found', 'link-unavailable'],
		[503, 'stripe_disabled', 'payments-disabled']
	])('shows %s without launching a replacement', async (status, code, phase) => {
		const h = setup({ checkout: [{ status, body: { code } }] });
		await h.controller.start();
		await h.controller.restart(review(h), partial);
		expect(h.checkoutCalls()).toHaveLength(1);
		expect(h.state.phase).toBe(phase);
		expect(h.state.paymentUncertain).toBe(true);
		expect(h.navigated).toEqual([]);
		expect(h.store.checkout()?.command.restartToken).toBe(
			status === 503 ? restartToken : undefined
		);
	});

	it('stores the exact command before sending and recovers it after the page closes mid-request', async () => {
		const pending = deferred();
		const h = setup({ checkout: [pending.promise] });
		await h.controller.start();
		const request = h.controller.restart(review(h), partial);
		await flush();
		const original = h.checkoutCalls()[0];
		expect(paymentStore(publicId, h.storage).checkout()).toMatchObject({
			key: original.headers['idempotency-key'],
			phase: 'sending',
			command: JSON.parse(original.body!)
		});
		h.controller.dispose();
		pending.settle(ok(openCheckout));
		await request;

		const back = setup({ storage: h.storage, hash: '', checkout: [ok(openCheckout)] });
		await back.controller.start();
		expect(back.state.pending?.ambiguous).toBe(true);
		await back.controller.restart(review(back), { partialCents: 10000n });
		expect(back.checkoutCalls()).toHaveLength(0);
		await back.controller.retry();
		expect(back.checkoutCalls()).toEqual([original]);
		expect(back.navigated).toEqual([openCheckout.url]);
	});

	it.each([
		{ checkoutRestartToken: restartToken.replace(/B+$/, 'C'.repeat(43)) },
		{ balance: '200.00', requiredAmount: '200.00' }
	])(
		'requires a new review when the target or terms change during freshness check (%j)',
		async (change) => {
			const h = setup({ summary: [ok(invoice), ok({ ...invoice, ...change })] });
			await h.controller.start();
			const reviewed = review(h);
			h.advance(MAX_SUMMARY_AGE_MS + 1);
			await h.controller.restart(reviewed, partial);
			expect(h.summaryCalls()).toHaveLength(2);
			expect(h.checkoutCalls()).toHaveLength(0);
			expect(h.state.notice).toBe('restart-changed');
		}
	);

	it('blocks restart while an earlier Elements confirmation is unresolved', async () => {
		const h = setup({
			summary: [ok(bookedSummary()), ok(invoice)],
			checkout: [ok({ ...embeddedCheckout, uiMode: 'ELEMENTS' })]
		});
		await h.controller.start();
		await h.controller.pay({ partialCents: 25000n });
		const original = h.state.checkout!;
		expect(h.controller.beginConfirmation(original.id)).toBe(true);
		h.controller.closeCheckout(original.id);
		await flush();
		await h.controller.restart(review(h), partial);
		expect(h.checkoutCalls()).toHaveLength(1);
		expect(h.store.checkout()?.completing).toBe(true);
		expect(original.isCurrent()).toBe(false);
	});

	it('requires a new ordinary payment decision if the previous session expires during review', async () => {
		const h = setup({ summary: [ok(invoice), ok(bookedSummary())], checkout: [ok(openCheckout)] });
		await h.controller.start();
		const reviewed = review(h);
		h.advance(MAX_SUMMARY_AGE_MS + 1);
		await h.controller.restart(reviewed, partial);
		expect(h.checkoutCalls()).toHaveLength(0);
		expect(h.state.view?.kind).toBe('balance-due');
		await h.controller.pay(partial);
		expect(JSON.parse(h.checkoutCalls()[0].body!)).not.toHaveProperty('restartToken');
	});

	it('keeps the earlier command intact if a replacement cannot be persisted', async () => {
		const h = setup();
		const previous: StoredCheckout = {
			key: 'original',
			command: { expectedDocumentVersion: 6, expectedBusinessRevision: 8, amountMinor: 25000 },
			purpose: 'INVOICE',
			amountCents: '25000',
			paidBefore: '240.00',
			lifecycleBefore: 'BOOKED',
			phase: 'redirected'
		};
		h.store.saveCheckout(previous);
		await h.controller.start();
		h.storage!.setItem = () => {
			throw new Error('quota');
		};
		await h.controller.restart(review(h), partial);
		expect(h.checkoutCalls()).toHaveLength(0);
		expect(h.state.notice).toBe('restart-storage-unavailable');
		expect(h.store.checkout()).toEqual(previous);
	});

	it.each([
		['payment_terms_changed', 'restart-changed'],
		['checkout_recovery_conflict', 'recovery-conflict'],
		['checkout_in_progress', 'checkout-open'],
		['payment_processing', 'processing'],
		['payment_state_changed', 'state-changed']
	])('refreshes without another POST on %s', async (code, notice) => {
		const summary =
			code === 'payment_state_changed'
				? bookedSummary({ reconciliationPending: true })
				: { ...invoice, checkoutRestartToken: undefined };
		const h = setup({
			summary: [ok(invoice), ok(summary)],
			checkout: [{ status: 409, body: { code } }]
		});
		await h.controller.start();
		await h.controller.restart(review(h), partial);
		expect(h.checkoutCalls()).toHaveLength(1);
		expect(h.state.notice).toBe(notice);
		expect(h.state.view).not.toHaveProperty('restart');
		expect(h.store.checkout()).toBeNull();
	});

	it.each([
		[500, 'internal_failure', 'ambiguous'],
		[409, 'checkout_reconciliation_required', 'reconciliation-required']
	])(
		'bounds %s retries to the original restart key and exact body',
		async (status, code, notice) => {
			const h = setup({ checkout: [{ status, body: { code } }] });
			await h.controller.start();
			await h.controller.restart(review(h), partial);
			const sent = h.checkoutCalls();
			expect(sent).toHaveLength(3);
			expect(
				sent.every(
					(call) => call.body === sent[0].body && call.headers['idempotency-key'] === 'key-1'
				)
			).toBe(true);
			expect(h.state.notice).toBe(notice);
			expect(h.store.checkout()?.command.restartToken).toBe(restartToken);
			if (status === 409) {
				await h.controller.retry();
				expect(h.checkoutCalls()).toHaveLength(3);
				expect(h.state.pending?.restartNeedsHelp).toBe(true);
			}
		}
	);

	it('preserves the original command after a restart key conflict', async () => {
		const h = setup({ checkout: [{ status: 409, body: { code: 'checkout_key_reused' } }] });
		await h.controller.start();
		await h.controller.restart(review(h), partial);
		await h.controller.startOver();
		await h.controller.retry();
		expect(h.checkoutCalls()).toHaveLength(1);
		expect(h.state.notice).toBe('restart-key-reused');
		expect(h.store.checkout()).toMatchObject({
			key: 'key-1',
			blocked: true,
			command: { restartToken }
		});
	});

	it.each(['EXPIRED', 'FAILED'])(
		'treats %s as a historical result and requires a new decision',
		async (state) => {
			const h = setup({
				summary: [ok(invoice), ok(bookedSummary())],
				checkout: [ok({ ...openCheckout, state })]
			});
			await h.controller.start();
			await h.controller.restart(review(h), partial);
			expect(h.state.notice).toBe('checkout-expired');
			expect(h.store.checkout()).toBeNull();
			expect(h.navigated).toEqual([]);
			expect(h.checkoutCalls()).toHaveLength(1);
		}
	);

	it.each([
		{ ...openCheckout, state: 'FUTURE_STATE' },
		{ ...openCheckout, uiMode: 'ELEMENTS', url: undefined },
		{ ...openCheckout, url: 'https://unexpected.test/checkout' }
	])('keeps a restart with an unsupported answer recoverable by exact key', async (response) => {
		const h = setup({ checkout: [ok(response)] });
		await h.controller.start();
		await h.controller.restart(review(h), partial);
		expect(h.state.pending?.ambiguous).toBe(true);
		expect(h.store.checkout()?.command.restartToken).toBe(restartToken);
		expect(h.state.checkout).toBeNull();
		expect(h.navigated).toEqual([]);
	});
});

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

describe.each(['EMBEDDED', 'ELEMENTS'] as const)('%s Checkout', (mode) => {
	const onPageCheckout = { ...embeddedCheckout, uiMode: mode };
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
			checkout: [ok(onPageCheckout)],
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
		expect(h.state.checkout).toMatchObject({
			attemptId: onPageCheckout.attemptId,
			purpose: 'DEPOSIT',
			amountCents: 24000n,
			businessRevision: 4
		});
		await expect(h.state.checkout!.clientSecret()).resolves.toBe(embeddedSecret);
		expect(h.store.checkout()).toMatchObject({
			key: 'key-1',
			phase: 'redirected',
			uiMode: mode
		});
		expect(exposure(h)).not.toContain(embeddedSecret);
		expect(Object.values(h.state.checkout!)).not.toContain(embeddedSecret);
		expect(h.state.view?.kind).toBe('in-progress');
		expect(h.state.paymentUncertain).toBe(true);
	});

	it('E: clicks, recovery and retries never authorize again while the form is open', async () => {
		const h = await opened();
		const launch = h.state.checkout;
		await Promise.all([
			h.controller.pay({ partialCents: null }),
			h.controller.recover({ partialCents: null }),
			h.controller.retry(),
			h.controller.refresh()
		]);
		expect(h.checkoutCalls()).toHaveLength(1);
		expect(h.state.checkout).toBe(launch);
	});

	it('retries a lost checkout response with the original command', async () => {
		const h = await opened({ checkout: ['network', ok(onPageCheckout)] });
		const [first, retry] = h.checkoutCalls();
		expect(retry).toEqual(first);
		expect(h.state.checkout?.mode).toBe(mode);
	});

	it('closing keeps the command and Session; continuing resends the same key and body', async () => {
		const h = await opened();
		const first = h.state.checkout!;
		h.controller.closeCheckout();
		await flush();
		expect(h.state.checkout).toBeNull();
		expect(h.state.notice).toBe('checkout-closed');
		await expect(first.clientSecret()).rejects.toThrow();
		expect(h.store.checkout()).toMatchObject({ key: 'key-1', uiMode: mode });
		expect(h.state.pending).toMatchObject({ uiMode: mode, completing: false });
		await h.controller.pay({ partialCents: null });
		expect(h.checkoutCalls()).toHaveLength(1); // the ordinary Pay stays closed
		await h.controller.recover({ partialCents: null });
		const [one, two] = h.checkoutCalls();
		expect(two.headers['idempotency-key']).toBe(one.headers['idempotency-key']);
		expect(two.body).toBe(one.body);
		expect(h.state.checkout?.id).not.toBe(first.id);
		await expect(h.state.checkout!.clientSecret()).resolves.toBe(embeddedSecret);
	});

	it('F: after a reload, the saved command reacquires the same Session, never a new one', async () => {
		const first = await opened();
		first.controller.dispose();
		const back = harness({
			storage: first.storage,
			summary: [ok(quotedUnderway)],
			checkout: [ok(onPageCheckout)],
			pollDelays: [60_000]
		});
		await back.controller.start();
		expect(back.state.checkout).toBeNull(); // the secret did not survive the reload
		expect(back.state.notice).toBe('checkout-closed');
		expect(noticeCopy('checkout-closed', null).body).not.toMatch(/charged|no charge|not paid/i);
		await back.controller.recover({ partialCents: null });
		expect(back.checkoutCalls()).toHaveLength(1);
		expect(back.checkoutCalls()[0].headers['idempotency-key']).toBe('key-1');
		expect(back.checkoutCalls()[0].body).toBe(depositBody);
		expect(back.state.checkout?.attemptId).toBe(onPageCheckout.attemptId);
		expect(exposure(back)).not.toContain(embeddedSecret);
	});

	it('G: each attempt launches by its own mode, whatever commerce is configured for now', async () => {
		// An embedded attempt stays embedded after commerce switches back to hosted...
		const embedded = await opened();
		embedded.controller.closeCheckout();
		await flush();
		await embedded.controller.recover({ partialCents: null });
		expect(embedded.navigated).toEqual([]);
		expect(embedded.state.checkout).not.toBeNull();
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
		expect(back.state.checkout).toBeNull();
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
		const launch = h.state.checkout!;
		const reads = h.summaryCalls().length;
		h.controller.checkoutComplete(launch.id + 1); // a stale launch callback is ignored
		expect(h.state.checkout).toBe(launch);
		h.controller.checkoutComplete(launch.id);
		expect(h.state.checkout).toBeNull();
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
		h.controller.checkoutComplete(h.state.checkout!.id);
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
		h.controller.checkoutComplete(h.state.checkout!.id);
		await flush();
		expect(h.state.notice).toBe('deposit-confirmed');
		expect(h.state.checkout).toBeNull();
		expect(h.store.checkout()).toBeNull();
		expect(h.state.view?.kind).toBe('balance-due');
		expect(noticeCopy('deposit-confirmed', h.state.summary).body).toContain('$960.00');
	});

	it('K: a partial Invoice payment shows the new balance; the next one is a new decision', async () => {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(bookedSummary())],
			checkout: [ok(onPageCheckout)],
			pollDelays: [60_000]
		});
		await h.controller.start();
		h.replySummary(ok(underway(bookedSummary())));
		await h.controller.pay({ partialCents: 10000n });
		expect(h.checkoutCalls()[0].body).toBe(
			'{"expectedDocumentVersion":6,"expectedBusinessRevision":8,"amountMinor":10000}'
		);
		expect(h.state.checkout).toMatchObject({ purpose: 'INVOICE', amountCents: 10000n });
		h.replySummary(
			ok(bookedSummary({ paidAmount: '340.00', balance: '860.00', requiredAmount: '860.00' }))
		);
		h.controller.checkoutComplete(h.state.checkout!.id);
		await flush();
		expect(h.state.notice).toBe('payment-received');
		expect(noticeCopy('payment-received', h.state.summary).body).toBe(
			'Your remaining balance is $860.00.'
		);
		expect(h.state.view).toMatchObject({ kind: 'balance-due', terms: { amountCents: 86000n } });
		expect(h.checkoutCalls()).toHaveLength(1); // nothing started on its own
		h.replyCheckout(ok({ ...onPageCheckout, attemptId: '0e7d1c8a-3b2f-4a5e-8c9d-1f2e3d4c5b6a' }));
		await h.controller.pay({ partialCents: null });
		expect(h.checkoutCalls()[1].headers['idempotency-key']).toBe('key-2');
	});

	it('removes the form when commerce no longer shows the attempt underway', async () => {
		const h = await opened();
		const launch = h.state.checkout!;
		h.replySummary(ok(quotedSummary({ document: { ...quotedSummary().document, version: 5 } })));
		await h.controller.refresh();
		expect(h.state.checkout).toBeNull();
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
		expect(revoked.state.checkout).toBeNull();
		expect(revoked.state.paymentUncertain).toBe(true);
		const disabled = await opened();
		disabled.replySummary({ status: 503, body: { code: 'stripe_disabled' } });
		await disabled.controller.refresh();
		expect(disabled.state.phase).toBe('payments-disabled');
		expect(disabled.state.checkout).toBeNull();
		expect(disabled.store.checkout()?.key).toBe('key-1');
	});

	it('keeps the form through a failed refresh, which Stripe does not depend on', async () => {
		const h = await opened();
		h.replySummary('network');
		await h.controller.refresh();
		expect(h.state.notice).toBe('refresh-failed');
		expect(h.state.checkout).not.toBeNull();
	});

	it('never launches from a terminal answer or an unknown mode', async () => {
		const terminal = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [ok({ ...onPageCheckout, state: 'EXPIRED' })]
		});
		await terminal.controller.start();
		await terminal.controller.pay({ partialCents: null });
		expect(terminal.state.checkout).toBeNull();
		expect(terminal.state.notice).toBe('checkout-expired');
		const unknown = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [ok({ ...onPageCheckout, uiMode: 'POPUP' })]
		});
		await unknown.controller.start();
		await unknown.controller.pay({ partialCents: null });
		expect(unknown.state.checkout).toBeNull();
		expect(unknown.navigated).toEqual([]);
		// Fail closed, keeping the command: only the same key may be retried.
		expect(unknown.state.notice).toBe('ambiguous');
		expect(unknown.store.checkout()).toMatchObject({ key: 'key-1', phase: 'sending' });
		expect(exposure(unknown)).not.toContain(embeddedSecret);
	});

	it('forgets the secret when the page goes away', async () => {
		const h = await opened();
		const launch = h.state.checkout!;
		h.controller.dispose();
		await expect(launch.clientSecret()).rejects.toThrow();
	});
});

describe('Elements confirmation preflight', () => {
	const underway = quotedSummary({
		canPay: false,
		paymentInProgress: true,
		unavailableReason: 'PAYMENT_IN_PROGRESS'
	});
	const elements = { ...embeddedCheckout, uiMode: 'ELEMENTS' };

	async function opened(options: Parameters<typeof harness>[0] = {}, invoice = false) {
		const summary = invoice ? bookedSummary() : quotedSummary();
		const h = harness({
			hash: `#${token}`,
			summary: [
				ok(summary),
				ok({
					...summary,
					canPay: false,
					paymentInProgress: true,
					unavailableReason: 'PAYMENT_IN_PROGRESS'
				})
			],
			checkout: [ok(elements)],
			pollDelays: [],
			...options
		});
		await h.controller.start();
		await h.controller.pay({ partialCents: invoice ? 20000n : null });
		return h;
	}

	const choice = { partialCents: null };
	const answer = (state: string, outcome = 'PENDING') => ok({ ...elements, state, outcome });

	async function interrupted(h: Awaited<ReturnType<typeof opened>>) {
		const { id } = h.state.checkout!;
		expect(h.controller.beginConfirmation(id)).toBe(true);
		h.controller.checkoutComplete(id, 'uncertain');
		await flush();
		expect(h.state.notice).toBe('confirmation-uncertain');
		expect(h.state.checkout).toBeNull();
		expect(h.checkoutCalls()).toHaveLength(1);
	}

	function expectSameCheck(h: Awaited<ReturnType<typeof opened>>, count = 2) {
		expect(h.checkoutCalls()).toHaveLength(count);
		for (const check of h.checkoutCalls().slice(1)) expect(check).toEqual(h.checkoutCalls()[0]);
	}

	it('checks commerce again and persists the in-flight marker before dispatch', async () => {
		const h = await opened();
		const id = h.state.checkout!.id;
		const reads = h.summaryCalls().length;
		expect(await h.controller.prepareConfirmation(id)).toBe(true);
		expect(h.summaryCalls()).toHaveLength(reads + 1);
		expect(h.controller.beginConfirmation(id)).toBe(true);
		expect(h.store.checkout()?.completing).toBe(true);
		expect(h.controller.beginConfirmation(id)).toBe(false);
		h.controller.confirmationRetryable(id + 1);
		expect(h.store.checkout()?.completing).toBe(true);
		h.controller.confirmationRetryable(id);
		expect(h.controller.beginConfirmation(id)).toBe(true);
	});

	it('blocks confirmation after a failed read or newer changes to the booking', async () => {
		const h = await opened();
		const launch = h.state.checkout!;
		h.replySummary('network');
		expect(await h.controller.prepareConfirmation(launch.id)).toBe(false);
		expect(h.controller.beginConfirmation(launch.id)).toBe(false);

		const older = deferred();
		h.replySummary(older.promise, ok({ ...underway, requiredAmount: '300.00' }));
		const prepare = h.controller.prepareConfirmation(launch.id);
		await h.controller.refresh();
		older.settle(ok(underway));
		expect(await prepare).toBe(false);
		expect(launch.isCurrent()).toBe(false);
		expect(h.controller.beginConfirmation(launch.id)).toBe(false);
		expect(h.store.checkout()?.key).toBe('key-1');
	});

	it('blocks a wallet or card preflight when staff records a payment below the authorized balance', async () => {
		const h = await opened({}, true);
		const launch = h.state.checkout!;
		const authorization = h.store.checkout();
		h.replySummary(
			ok({
				...bookedSummary({ paidAmount: '1100.00', balance: '100.00', requiredAmount: '100.00' }),
				canPay: false,
				paymentInProgress: true,
				unavailableReason: 'PAYMENT_IN_PROGRESS'
			})
		);
		expect(await h.controller.prepareConfirmation(launch.id)).toBe(false);
		expect(h.controller.beginConfirmation(launch.id)).toBe(false);
		expect(launch.isCurrent()).toBe(false);
		expect(h.state.checkout).toBeNull();
		expect(h.store.checkout()).toEqual(authorization);
		await h.controller.pay(choice);
		expect(h.checkoutCalls()).toHaveLength(1);
	});

	it.each(['redirected', 'sending'] as const)(
		'after interrupted confirmation, reload resumes the verified OPEN attempt (%s)',
		async (phase) => {
			const first = await opened();
			const id = first.state.checkout!.id;
			expect(first.controller.beginConfirmation(id)).toBe(true);
			if (phase === 'sending') {
				// A reload during an earlier release's same-key check may lack an attempt ID.
				first.store.saveCheckout({ ...first.store.checkout()!, phase, attemptId: undefined });
			}
			first.controller.dispose();
			const reloaded = harness({
				storage: first.storage,
				summary: [ok(underway)],
				checkout: [ok(elements)],
				pollDelays: []
			});
			await reloaded.controller.start();
			expect(reloaded.state.notice).toBe('confirmation-uncertain');
			expect(reloaded.checkoutCalls()).toHaveLength(0);
			await reloaded.controller.recover(choice);
			expect(reloaded.checkoutCalls()[0]).toEqual(first.checkoutCalls()[0]);
			expect(reloaded.checkoutCalls()).toHaveLength(1);
			expect(reloaded.state.checkout).toMatchObject({
				attemptId: elements.attemptId,
				mode: 'ELEMENTS'
			});
			expect(reloaded.state.pending?.completing).toBe(false);
			expect(reloaded.store.checkout()?.phase).toBe('redirected');
			expect(reloaded.state.notice).toBeNull();
			await expect(reloaded.state.checkout!.clientSecret()).resolves.toBe(embeddedSecret);
		}
	);

	it('waits for a new summary and ignores repeated clicks while checking the original authorization', async () => {
		const h = await opened();
		await interrupted(h);
		const summary = deferred();
		h.replySummary(summary.promise);
		const checking = h.controller.recover(choice);
		await flush();
		expect(h.state.checkout).toBeNull();
		expect(h.store.checkout()?.completing).toBe(true);
		await Promise.all([
			h.controller.recover(choice),
			h.controller.retry(),
			h.controller.pay(choice)
		]);
		expectSameCheck(h);
		summary.settle(ok(underway));
		await checking;
		expect(h.state.checkout?.attemptId).toBe(elements.attemptId);
		expect(h.store.checkout()?.completing).toBeUndefined();
		expectSameCheck(h);
	});

	it.each(['PROCESSING', 'SUCCEEDED'])(
		'%s keeps the form closed pending ledger confirmation',
		async (state) => {
			const h = await opened();
			await interrupted(h);
			h.replyCheckout(answer(state, state === 'SUCCEEDED' ? 'APPLIED' : 'PENDING'));
			await h.controller.recover(choice);
			expect(h.state.notice).toBe('confirming');
			expect(h.state.checkout).toBeNull();
			expect(h.store.checkout()?.awaitingSettlement).toBe(true);
			// An anomalous later OPEN answer cannot reopen an attempt known to have advanced.
			h.replyCheckout(ok(elements));
			await h.controller.recover(choice);
			expect(h.state.checkout).toBeNull();
			expectSameCheck(h, 3);
			h.replySummary(ok(bookedSummary()));
			await h.controller.refresh();
			expect(h.state.notice).toBe('deposit-confirmed');
			expect(h.store.checkout()).toBeNull();
		}
	);

	it.each(['EXPIRED', 'FAILED'])(
		'%s releases the lock and requires a deliberate new payment',
		async (state) => {
			const h = await opened();
			await interrupted(h);
			h.replyCheckout(answer(state));
			h.replySummary(ok(quotedSummary()));
			await h.controller.recover(choice);
			expect(h.state.notice).toBe('checkout-expired');
			expect(h.store.checkout()).toBeNull();
			expect(h.state.checkout).toBeNull();
			expectSameCheck(h);
		}
	);

	it.each([
		'network',
		{ status: 504, body: { code: 'unavailable' } },
		ok({ ...elements, outcome: 'APPLIED' }),
		ok({ ...elements, attemptId: publicId }),
		ok({ ...openCheckout })
	] satisfies Reply[])('keeps an unresolved check recoverable (%#)', async (reply) => {
		const h = await opened();
		await interrupted(h);
		const saved = h.store.checkout();
		h.replyCheckout(reply);
		h.replySummary(ok(quotedSummary())); // no ledger confirmation and no per-attempt status
		await h.controller.recover(choice);
		expect(h.state.notice).toBe('confirmation-uncertain');
		expect(h.state.checkout).toBeNull();
		expect(h.store.checkout()).toEqual(saved);
		await h.controller.pay(choice);
		expectSameCheck(h);
	});

	it('an unavailable summary cannot unlock a verified OPEN response', async () => {
		const h = await opened();
		await interrupted(h);
		h.replySummary('network');
		await h.controller.recover(choice);
		expect(h.state.checkout).toBeNull();
		expect(h.store.checkout()?.completing).toBe(true);
		expectSameCheck(h);
	});

	it('a reported Stripe completion keeps the same attempt locked even if a check returns OPEN', async () => {
		const h = await opened();
		const { id } = h.state.checkout!;
		expect(h.controller.beginConfirmation(id)).toBe(true);
		h.controller.checkoutComplete(id);
		await flush();
		await h.controller.recover(choice);
		expect(h.state.notice).toBe('confirming');
		expect(h.state.checkout).toBeNull();
		expect(h.store.checkout()).toMatchObject({ completing: true, awaitingSettlement: true });
		expectSameCheck(h);
	});

	it('a key conflict blocks further checks and cannot start a replacement', async () => {
		const h = await opened();
		await interrupted(h);
		h.replyCheckout({ status: 409, body: { code: 'conflict', message: 'CHECKOUT_KEY_REUSED' } });
		await h.controller.recover(choice);
		expect(h.state.pending?.blocked).toBe(true);
		await Promise.all([
			h.controller.recover(choice),
			h.controller.retry(),
			h.controller.startOver()
		]);
		expect(h.store.checkout()).toMatchObject({ key: 'key-1', completing: true, blocked: true });
		expectSameCheck(h);
	});

	it.each([
		[
			'Invoice amended',
			true,
			{ ...bookedSummary(), document: { ...bookedSummary().document, version: 7 } }
		],
		[
			'manual payment',
			true,
			bookedSummary({ paidAmount: '1100.00', balance: '100.00', requiredAmount: '100.00' })
		],
		['deposit changed', false, quotedSummary({ requiredAmount: '300.00' })]
	] as const)(
		'%s during recovery prevents reopening an old authorization',
		async (_name, invoice, summary) => {
			const h = await opened({}, invoice);
			await interrupted(h);
			h.replySummary(
				ok({
					...summary,
					paymentInProgress: true,
					canPay: false,
					unavailableReason: 'PAYMENT_IN_PROGRESS'
				})
			);
			await h.controller.recover(choice);
			expect(h.state.checkout).toBeNull();
			expect(h.state.notice).toBe('checkout-invalidated');
			expect(h.store.checkout()?.completing).toBe(true);
			expectSameCheck(h);
		}
	);

	it('a revoked link during recovery cannot reopen a form', async () => {
		const h = await opened();
		await interrupted(h);
		h.replySummary({ status: 404, body: { code: 'not_found' } });
		await h.controller.recover(choice);
		expect(h.state.phase).toBe('link-unavailable');
		expect(h.state.checkout).toBeNull();
		expect(h.state.paymentUncertain).toBe(true);
		expectSameCheck(h);
	});

	it('a later poll supersedes the matching recovery summary', async () => {
		let poll: (() => void) | undefined;
		const h = await opened({
			pollDelays: [1],
			setTimer(callback) {
				poll = callback;
				return callback;
			},
			clearTimer() {
				poll = undefined;
			}
		});
		await interrupted(h);
		const older = deferred();
		h.replySummary(older.promise, ok({ ...underway, requiredAmount: '300.00' }));
		const checking = h.controller.recover(choice);
		await flush();
		poll!();
		await flush();
		older.settle(ok(underway));
		await checking;
		expect(h.state.checkout).toBeNull();
		expect(h.state.notice).toBe('checkout-invalidated');
		expect(h.store.checkout()?.completing).toBe(true);
		expectSameCheck(h);
	});
});

describe.each(['EMBEDDED', 'ELEMENTS'] as const)('%s forms whose terms changed', (mode) => {
	const onPageCheckout = { ...embeddedCheckout, uiMode: mode };
	const underway = (summary: Record<string, unknown>) => ({
		...summary,
		paymentInProgress: true,
		canPay: false,
		unavailableReason: 'PAYMENT_IN_PROGRESS',
		checkoutRecoveryAvailable: true
	});
	const invoiceBody =
		'{"expectedDocumentVersion":6,"expectedBusinessRevision":8,"amountMinor":20000}';
	const invoiceV9 = () =>
		bookedSummary({ document: { ...bookedSummary().document, version: 7, businessRevision: 9 } });

	/** A booked Invoice with an open embedded $200 partial payment, still underway. */
	async function invoiceOpen() {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(bookedSummary())],
			checkout: [ok(onPageCheckout)],
			pollDelays: [60_000]
		});
		await h.controller.start();
		h.replySummary(ok(underway(bookedSummary())));
		await h.controller.pay({ partialCents: 20000n });
		expect(h.state.checkout).toMatchObject({ purpose: 'INVOICE', amountCents: 20000n });
		return h;
	}
	async function depositOpen() {
		const h = harness({
			hash: `#${token}`,
			summary: [ok(quotedSummary())],
			checkout: [ok(onPageCheckout)],
			pollDelays: [60_000]
		});
		await h.controller.start();
		h.replySummary(ok(underway(quotedSummary())));
		await h.controller.pay({ partialCents: null });
		expect(h.state.checkout).not.toBeNull();
		return h;
	}
	/** Receives one authoritative summary and checks the form is gone but the attempt is kept. */
	async function expectInvalidated(h: ReturnType<typeof harness>, summary: unknown) {
		const launch = h.state.checkout!;
		const saved = h.store.checkout();
		h.replySummary(ok(summary));
		await h.controller.refresh();
		expect(h.state.checkout).toBeNull();
		await expect(launch.clientSecret()).rejects.toThrow();
		expect(h.store.checkout()).toEqual(saved); // same key, body, amount, purpose, revisions
		expect(h.state.notice).toBe('checkout-invalidated');
		expect(h.state.pending).toMatchObject({ termsChanged: true, completing: false });
		expect(h.state.view?.kind).toBe('in-progress');
		expect(h.checkoutCalls()).toHaveLength(1); // never a replacement on its own
		return launch;
	}

	it('A: a new Invoice revision removes the form even while the attempt stays underway', async () => {
		const h = await invoiceOpen();
		await expectInvalidated(h, underway(invoiceV9()));
		expect(h.store.checkout()?.command).toEqual({
			expectedDocumentVersion: 6,
			expectedBusinessRevision: 8,
			amountMinor: 20000
		});
	});

	it('B: a manual payment that leaves less than the authorized amount removes the form', async () => {
		const h = await invoiceOpen();
		// Same document version and revision; only the applied money changed.
		await expectInvalidated(
			h,
			underway(
				bookedSummary({ paidAmount: '1100.00', balance: '100.00', requiredAmount: '100.00' })
			)
		);
	});

	it('B2: a fully paid Invoice or a CLOSED booking removes the form', async () => {
		const paid = await invoiceOpen();
		await expectInvalidated(
			paid,
			underway(bookedSummary({ paidAmount: '1200.00', balance: '0.00', requiredAmount: '0.00' }))
		);
		const closed = await invoiceOpen();
		const launch = closed.state.checkout!;
		closed.replySummary(ok(underway(bookedSummary({ lifecycle: 'CLOSED' }))));
		await closed.controller.refresh();
		expect(closed.state.checkout).toBeNull();
		await expect(launch.clientSecret()).rejects.toThrow();
	});

	it('C: a changed deposit requirement removes the form and keeps the command', async () => {
		const h = await depositOpen();
		await expectInvalidated(h, underway(quotedSummary({ requiredAmount: '300.00' })));
		expect(h.store.checkout()).toMatchObject({ key: 'key-1', amountCents: '24000' });
	});

	it('D: a deposit form is never reused as an Invoice payment', async () => {
		const h = await depositOpen();
		// Same version, revision and amount, but now an Invoice: a different authorization.
		await expectInvalidated(
			h,
			underway(
				bookedSummary({
					document: { ...quotedSummary().document, stage: 'INVOICE' },
					balance: '240.00',
					requiredAmount: '240.00'
				})
			)
		);
	});

	it('E: an unchanged authoritative refresh keeps the same mounted form', async () => {
		const h = await invoiceOpen();
		const launch = h.state.checkout;
		h.replySummary(ok(underway(bookedSummary({ history: [] }))));
		await h.controller.refresh();
		await h.controller.refresh();
		expect(h.state.checkout).toBe(launch);
		expect(h.state.notice).toBeNull();
		await expect(launch!.clientSecret()).resolves.toBe(embeddedSecret);
	});

	it('F: failed or 5xx summary reads never count as changed terms', async () => {
		const h = await invoiceOpen();
		const launch = h.state.checkout;
		for (const reply of ['network', { status: 502, body: { code: 'internal_failure' } }] as const) {
			h.replySummary(reply);
			await h.controller.refresh();
			expect(h.state.checkout).toBe(launch);
			expect(h.state.notice).toBe('refresh-failed');
			expect(h.state.summaryFresh).toBe(false);
		}
		await expect(launch!.clientSecret()).resolves.toBe(embeddedSecret);
	});

	it('G: an older changed summary arriving last cannot remove a form the newer one kept', async () => {
		const h = await invoiceOpen();
		const launch = h.state.checkout;
		const older = deferred();
		const newer = deferred();
		h.replySummary(older.promise, newer.promise);
		const reads = [h.controller.refresh(), h.controller.refresh()];
		await flush();
		newer.settle(ok(underway(bookedSummary())));
		await flush();
		older.settle(ok(underway(invoiceV9())));
		await Promise.all(reads);
		expect(h.state.checkout).toBe(launch);
		expect(h.state.summary?.document.version).toBe(6);
	});

	it('G2: an older matching summary arriving last cannot restore an invalidated form', async () => {
		const h = await invoiceOpen();
		const older = deferred();
		const newer = deferred();
		h.replySummary(older.promise, newer.promise);
		const reads = [h.controller.refresh(), h.controller.refresh()];
		await flush();
		newer.settle(ok(underway(invoiceV9())));
		await flush();
		expect(h.state.checkout).toBeNull();
		older.settle(ok(underway(bookedSummary())));
		await Promise.all(reads);
		expect(h.state.checkout).toBeNull();
		expect(h.state.notice).toBe('checkout-invalidated');
		expect(h.state.summary?.document.version).toBe(7);
	});

	it('keeps the explanation through routine refreshes while the attempt is unresolved', async () => {
		const h = await invoiceOpen();
		await expectInvalidated(h, underway(invoiceV9()));
		h.replySummary(ok(underway(invoiceV9())));
		await h.controller.refresh();
		await h.controller.refresh();
		expect(h.state.notice).toBe('checkout-invalidated');
		expect(noticeCopy('checkout-invalidated', h.state.summary).body).not.toMatch(
			/cancel|expired|refund|not charged|no charge/i
		);
	});

	it('H: the explicit check resends the same key and body and never shows the stale form', async () => {
		const h = await invoiceOpen();
		await expectInvalidated(h, underway(invoiceV9()));
		await h.controller.pay({ partialCents: 10000n }); // the ordinary Pay stays closed
		expect(h.checkoutCalls()).toHaveLength(1);
		// Commerce returns the original, still-open Session for the same key.
		h.replyCheckout(ok(onPageCheckout));
		const before = h.states.length;
		await h.controller.recover({ partialCents: null });
		// Not even briefly: the stale Session's form is never mounted again.
		expect(h.states.slice(before).every((s) => s.checkout === null)).toBe(true);
		const [first, check] = h.checkoutCalls();
		expect(check.headers['idempotency-key']).toBe(first.headers['idempotency-key']);
		expect(check.body).toBe(invoiceBody);
		expect(first.body).toBe(invoiceBody);
		expect(h.checkoutCalls()).toHaveLength(2);
		expect(h.state.checkout).toBeNull(); // its secret was dropped, never mounted
		expect(h.state.notice).toBe('checkout-invalidated');
		expect(h.store.checkout()?.key).toBe('key-1');
		await flush();
		expect(h.checkoutCalls()).toHaveLength(2);
	});

	it.each([
		[ok({ ...onPageCheckout, state: 'EXPIRED', clientSecret: undefined }), 'checkout-expired'],
		[
			{ status: 409, body: { code: 'conflict', message: 'PAYMENT_TERMS_CHANGED' } },
			'terms-changed'
		],
		[{ status: 409, body: { code: 'checkout_reconciliation_required' } }, 'reconciliation-required']
	])(
		'H2: the check follows commerce’s outcome through the existing rules (%#)',
		async (reply, notice) => {
			const h = await invoiceOpen();
			await expectInvalidated(h, underway(invoiceV9()));
			h.replyCheckout(reply);
			h.replySummary(ok(invoiceV9()));
			await h.controller.recover({ partialCents: null });
			expect(h.state.notice).toBe(notice);
			expect(h.state.checkout).toBeNull();
			expect(h.checkoutCalls()).toHaveLength(2);
			expect(h.checkoutCalls()[1].headers['idempotency-key']).toBe('key-1');
		}
	);

	it('H3: a new payment after the old attempt is resolved is a fresh, reviewed decision', async () => {
		const h = await invoiceOpen();
		await expectInvalidated(h, underway(invoiceV9()));
		h.replyCheckout(ok({ ...onPageCheckout, state: 'EXPIRED', clientSecret: undefined }));
		h.replySummary(ok(invoiceV9()));
		await h.controller.recover({ partialCents: null });
		expect(h.store.checkout()).toBeNull();
		h.replyCheckout(ok({ ...onPageCheckout, attemptId: '0e7d1c8a-3b2f-4a5e-8c9d-1f2e3d4c5b6a' }));
		h.replySummary(ok(underway(invoiceV9())));
		await h.controller.pay({ partialCents: 20000n });
		const fresh = h.checkoutCalls()[2];
		expect(fresh.headers['idempotency-key']).toBe('key-2');
		expect(fresh.body).toBe(
			'{"expectedDocumentVersion":7,"expectedBusinessRevision":9,"amountMinor":20000}'
		);
		expect(h.state.checkout).toMatchObject({ businessRevision: 9, amountCents: 20000n });
	});

	it('I: a late Stripe completion after invalidation cannot revive the form or claim success', async () => {
		const h = await invoiceOpen();
		const launch = await expectInvalidated(h, underway(invoiceV9()));
		h.controller.checkoutComplete(launch.id);
		expect(h.state.notice).toBe('checkout-invalidated');
		expect(h.state.checkout).toBeNull();
		expect(h.store.checkout()?.completing).toBeUndefined();
		await expect(launch.clientSecret()).rejects.toThrow(); // a pending Stripe init gets nothing
		expect(h.states.some((s) => s.notice === 'payment-received')).toBe(false);
	});

	it('a completion that raced an amendment keeps confirming, never offers the form again', async () => {
		const h = await invoiceOpen();
		h.replySummary(ok(underway(invoiceV9())));
		h.controller.checkoutComplete(h.state.checkout!.id);
		await flush();
		expect(h.state.notice).toBe('confirming');
		expect(h.state.checkout).toBeNull();
		expect(h.state.pending).toMatchObject({ completing: true });
	});
});

describe('authorizationMatches', () => {
	const stored = (overrides: Partial<StoredCheckout> = {}): StoredCheckout => ({
		key: 'k',
		command: { expectedDocumentVersion: 6, expectedBusinessRevision: 8, amountMinor: 20000 },
		purpose: 'INVOICE',
		amountCents: '20000',
		paidBefore: '240.00',
		lifecycleBefore: 'BOOKED',
		phase: 'redirected',
		...overrides
	});
	const deposit = stored({
		command: { expectedDocumentVersion: 3, expectedBusinessRevision: 4 },
		purpose: 'DEPOSIT',
		amountCents: '24000',
		paidBefore: '0.00',
		lifecycleBefore: 'QUOTED'
	});
	const matches = (s: StoredCheckout, summary: Record<string, unknown>) =>
		authorizationMatches(s, readSummary(summary)!);

	it('matches unchanged terms, whatever the in-progress flags say', () => {
		expect(matches(stored(), bookedSummary())).toBe(true);
		expect(matches(stored(), bookedSummary({ paymentInProgress: true, canPay: false }))).toBe(true);
		expect(matches(stored(), bookedSummary({ lifecycle: 'SERVED' }))).toBe(true);
		expect(matches(stored({ amountCents: '96000' }), bookedSummary())).toBe(true);
		expect(matches(deposit, quotedSummary())).toBe(true);
	});

	it('refuses any change the public summary can show', () => {
		const doc = bookedSummary().document;
		for (const changed of [
			bookedSummary({ document: { ...doc, version: 7 } }),
			bookedSummary({ document: { ...doc, businessRevision: 9 } }),
			bookedSummary({ document: { ...doc, stage: 'QUOTE' } }),
			bookedSummary({ mode: 'DEPOSIT' }),
			bookedSummary({ lifecycle: 'CLOSED' }),
			bookedSummary({ lifecycle: 'QUOTED' }),
			bookedSummary({ balance: '199.99' }),
			bookedSummary({ balance: '0.00' }),
			bookedSummary({ balance: '-5.00' })
		])
			expect(matches(stored(), changed)).toBe(false);
		expect(matches(deposit, quotedSummary({ requiredAmount: '240.01' }))).toBe(false);
		expect(matches(deposit, quotedSummary({ mode: 'INVOICE' }))).toBe(false);
		expect(matches(deposit, bookedSummary())).toBe(false);
	});
});
