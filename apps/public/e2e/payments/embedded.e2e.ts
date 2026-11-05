import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { bookedSummary, quotedSummary } from '../../src/lib/payments/testing/fixtures.js';

/*
 * Embedded Checkout on /pay, end to end against the commerce stub. Stripe.js itself is replaced by
 * a routed fake on https://js.stripe.com (loaded through the real @stripe/stripe-js loader), whose
 * placeholder iframe also comes from js.stripe.com so the page's frame-src policy is exercised.
 * Stripe's real card form is never automated here; see the manual test-mode acceptance runbook.
 */

const stub = `http://127.0.0.1:${process.env.PAYMENTS_STUB_PORT ?? '4031'}`;
type Summary = ReturnType<typeof quotedSummary>;
type UiMode = 'HOSTED' | 'EMBEDDED' | 'LEGACY';
type Call = { method: string; url: string; key?: string; body?: string };

async function scenario(request: APIRequestContext, summary: Summary, uiMode: UiMode) {
	const response = await request.post(`${stub}/__test__/scenario`, { data: { summary, uiMode } });
	expect(response.ok()).toBe(true);
	return (await response.json()) as { publicId: string; token: string };
}
async function update(request: APIRequestContext, publicId: string, data: unknown) {
	expect((await request.post(`${stub}/__test__/scenario/${publicId}`, { data })).ok()).toBe(true);
}
async function stubState(request: APIRequestContext, publicId: string) {
	return (await (await request.get(`${stub}/__test__/scenario/${publicId}`)).json()) as {
		calls: Call[];
		secrets: string[];
	};
}
const posts = async (request: APIRequestContext, publicId: string) =>
	(await stubState(request, publicId)).calls.filter((c) => c.method === 'POST');
const open = (page: Page, publicId: string, token?: string) =>
	page.goto(`/pay/${publicId}${token ? `#${token}` : ''}`);
/** What commerce reports while an attempt is open: underway, no new collection. */
const underway = (summary: Summary) => ({
	...summary,
	canPay: false,
	unavailableReason: 'PAYMENT_IN_PROGRESS',
	paymentInProgress: true,
	checkoutRecoveryAvailable: true
});

const FAKE_STRIPE_JS = `(() => {
	const t = (window.__stripeTest = { creates: 0, mounts: 0, destroys: 0, live: 0, keys: [], complete: null });
	function Stripe(key) {
		t.keys.push(key);
		return {
			async createEmbeddedCheckoutPage(options) {
				// Like Stripe: one Embedded Checkout per page at a time.
				if (t.live > 0) throw new Error('IntegrationError: multiple Embedded Checkouts');
				t.live++;
				t.creates++;
				const secret = await options.fetchClientSecret();
				if (!/^cs_test_[A-Za-z0-9_]+$/.test(secret)) throw new Error('invalid client secret');
				let frame = null;
				let destroyed = false;
				return {
					mount(target) {
						const el = typeof target === 'string' ? document.querySelector(target) : target;
						frame = document.createElement('iframe');
						frame.src = 'https://js.stripe.com/test-embedded-checkout.html';
						frame.title = 'Secure checkout (test)';
						frame.style.cssText = 'display:block;width:100%;height:380px;border:0';
						el.appendChild(frame);
						t.mounts++;
						t.complete = () => options.onComplete && options.onComplete();
					},
					unmount() { frame && frame.remove(); },
					destroy() {
						if (destroyed) return;
						destroyed = true;
						frame && frame.remove();
						t.destroys++;
						t.live--;
						t.complete = null;
					}
				};
			}
		};
	}
	Stripe.version = 'endive';
	window.Stripe = Stripe;
})();`;

const FAKE_FORM = `<!doctype html><meta charset="utf-8"><title>Stripe test form</title>
<style>body{font:15px system-ui;margin:0;padding:20px;background:#fff;color:#30313d}
label{display:block;margin:10px 0 4px;font-size:13px}div.f{border:1px solid #e0e0e6;border-radius:6px;padding:10px;color:#8a8a99}
button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:6px;background:#0570de;color:#fff;font-weight:600}</style>
<label>Email</label><div class="f">you@example.com</div><label>Card information</label>
<div class="f">1234 1234 1234 1234 · MM / YY · CVC</div><button type="button">Pay (test)</button>`;

/** Routes js.stripe.com to the fake; `state.fail` makes the next loads fail like a blocker would. */
async function fakeStripe(page: Page) {
	const state = { fail: false, requests: [] as string[] };
	await page.route('https://js.stripe.com/**', async (route) => {
		const url = route.request().url();
		state.requests.push(url);
		if (state.fail) return route.abort('blockedbyclient');
		if (/\/stripe\.js(\?|$)/.test(url))
			return route.fulfill({ contentType: 'text/javascript', body: FAKE_STRIPE_JS });
		return route.fulfill({ contentType: 'text/html', body: FAKE_FORM });
	});
	return state;
}
const stripeTest = (page: Page) =>
	page.evaluate(() => {
		const t = (window as unknown as { __stripeTest?: Record<string, unknown> }).__stripeTest;
		return t ? { ...t, complete: typeof t.complete === 'function' } : null;
	});
/** Stripe reports completion only from a mounted form: wait for it, then fire onComplete. */
async function completeInStripe(page: Page) {
	type Fake = { __stripeTest?: { complete: (() => void) | null } };
	await page.waitForFunction(
		() => typeof (window as unknown as Fake).__stripeTest?.complete === 'function'
	);
	await page.evaluate(() => (window as unknown as Fake).__stripeTest!.complete!());
}

/** Console output, sessionStorage, localStorage, cookies and the URL: no secret may appear. */
async function persisted(page: Page, logs: string[]) {
	return JSON.stringify({
		logs,
		url: page.url(),
		session: await page.evaluate(() => ({ ...sessionStorage })),
		local: await page.evaluate(() => ({ ...localStorage })),
		cookie: await page.evaluate(() => document.cookie),
		history: await page.evaluate(() => JSON.stringify(history.state))
	});
}

test('an embedded deposit stays on the page and confirms only from commerce', async ({
	page,
	request
}) => {
	const logs: string[] = [];
	page.on('console', (message) => logs.push(message.text()));
	const { publicId, token } = await scenario(request, quotedSummary(), 'EMBEDDED');
	const stripe = await fakeStripe(page);
	const response = await open(page, publicId, token);
	expect(response!.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
	expect(response!.headers()['content-security-policy']).toContain('https://js.stripe.com');
	await expect(page.getByTestId('deposit-amount')).toHaveText('$240.00');
	// D: Stripe.js is not loaded until an embedded payment actually needs it.
	expect(stripe.requests).toEqual([]);
	expect(await stripeTest(page)).toBeNull();

	await page.getByRole('button', { name: 'Pay deposit $240.00' }).click();
	const panel = page.getByTestId('embedded-checkout');
	await expect(panel.getByRole('heading', { name: 'Complete your payment' })).toBeFocused();
	await expect(panel.getByTestId('embedded-amount')).toHaveText('$240.00');
	await expect(panel).toContainText("Deposit for your Fiona's Ice Cream booking (Quote v4)");
	await expect(panel).toContainText('Secure payment powered by Stripe');
	await expect(panel.locator('iframe[title="Secure checkout (test)"]')).toBeVisible();
	await expect(
		page.frameLocator('iframe[title="Secure checkout (test)"]').getByText('Card information')
	).toBeVisible();
	await expect(page.getByTestId('payment-overview')).toBeVisible(); // the booking stays in view
	await expect(page.getByTestId('pay')).toHaveCount(0);
	expect(page.url()).toBe(`${test.info().project.use.baseURL}/pay/${publicId}`);
	expect(await stripeTest(page)).toMatchObject({
		creates: 1,
		mounts: 1,
		destroys: 0,
		keys: ['pk_test_51FionasE2EOnlyNotARealKey000']
	});
	expect(stripe.requests[0]).toMatch(/^https:\/\/js\.stripe\.com\/[a-z0-9]+\/stripe\.js/);
	const [post] = await posts(request, publicId);
	expect(post.body).toBe('{"expectedDocumentVersion":3,"expectedBusinessRevision":4}');
	if (process.env.PAYMENTS_SCREENSHOTS) {
		// Opt-in captures for reviews; a full-page capture on a phone repaints the sticky header.
		const mobile = test.info().project.name.startsWith('mobile');
		if (mobile) await panel.scrollIntoViewIfNeeded();
		await page.screenshot({
			path: `${process.env.PAYMENTS_SCREENSHOTS}/embedded-${test.info().project.name}.png`,
			fullPage: !mobile
		});
	}

	// N: the client secret exists only in memory.
	const [secret] = (await stubState(request, publicId)).secrets;
	expect(secret).toMatch(/^cs_test_/);
	expect(await persisted(page, logs)).not.toContain(secret);
	expect(await page.content()).not.toContain(secret);
	expect(logs.join('\n')).not.toMatch(/Refused to (frame|load)/);

	// H: Stripe's completion callback starts confirmation; it is never itself success.
	await completeInStripe(page);
	await expect(panel).toHaveCount(0);
	await expect(page.getByTestId('payment-notice')).toContainText('Confirming your payment');
	await expect(page.getByRole('heading', { name: "We're confirming your payment" })).toBeVisible();
	await expect(page.getByText('Deposit received')).toHaveCount(0);
	await expect(page.getByTestId('pay')).toHaveCount(0);
	await expect(page.getByTestId('recover-payment')).toHaveCount(0);
	expect(await stripeTest(page)).toMatchObject({ destroys: 1, live: 0 });

	// J: only commerce's BOOKED summary confirms it.
	await update(request, publicId, {
		summary: bookedSummary({
			history: [{ amount: '240.00', refundedAmount: '0.00', receivedAt: '2027-03-01T18:00:00Z' }]
		})
	});
	await expect(page.getByTestId('payment-notice')).toContainText(
		'Deposit received. Your booking is confirmed.',
		{ timeout: 15_000 }
	);
	await expect(page.getByTestId('stage-label')).toHaveText('Booked');
	await expect(page.getByTestId('document-label')).toContainText('Invoice v8');
	await expect(page.getByTestId('figure-balance')).toContainText('$960.00');
	await expect(page.getByTestId('payment-history')).toContainText('$240.00');
	expect(await posts(request, publicId)).toHaveLength(1);
	expect(await persisted(page, logs)).not.toContain(secret);
});

test('closing returns to the booking; continuing reopens the same Session, never a new one', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, quotedSummary(), 'EMBEDDED');
	await fakeStripe(page);
	await open(page, publicId, token);
	await page.getByRole('button', { name: 'Pay deposit $240.00' }).click();
	await expect(page.locator('iframe[title="Secure checkout (test)"]')).toBeVisible();
	await page.getByRole('button', { name: 'Back to booking overview' }).click();
	await expect(page.getByTestId('embedded-checkout')).toHaveCount(0);
	await expect(page.locator('iframe')).toHaveCount(0);
	await expect(page.getByTestId('payment-notice')).toContainText('Your payment is still open');
	await expect(page.getByTestId('payment-notice')).not.toContainText(/cancel|not charged/i);
	await expect(page.getByTestId('pay')).toHaveCount(0);
	expect(await stripeTest(page)).toMatchObject({ creates: 1, destroys: 1, live: 0 });

	await page.getByRole('button', { name: 'Continue your payment' }).click();
	await expect(page.locator('iframe[title="Secure checkout (test)"]')).toBeVisible();
	expect(await stripeTest(page)).toMatchObject({ creates: 2, mounts: 2, live: 1 });
	const sent = await posts(request, publicId);
	expect(sent).toHaveLength(2);
	expect(sent[1].key).toBe(sent[0].key);
	expect(sent[1].body).toBe(sent[0].body);
	expect(new Set((await stubState(request, publicId)).secrets).size).toBe(1);
});

test('a reload loses the secret and reacquires the original Session with the same key', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, quotedSummary(), 'EMBEDDED');
	await fakeStripe(page);
	await open(page, publicId, token);
	await page.getByRole('button', { name: 'Pay deposit $240.00' }).click();
	await expect(page.locator('iframe[title="Secure checkout (test)"]')).toBeVisible();
	const reloaded = await page.reload();
	const [secret] = (await stubState(request, publicId)).secrets;
	expect(await reloaded!.text()).not.toContain(secret);
	await expect(page.getByTestId('payment-notice')).toContainText('Your payment is still open');
	await expect(page.getByTestId('embedded-checkout')).toHaveCount(0);
	expect(await posts(request, publicId)).toHaveLength(1); // nothing sent on its own
	await page.getByRole('button', { name: 'Continue your payment' }).click();
	await expect(page.locator('iframe[title="Secure checkout (test)"]')).toBeVisible();
	const sent = await posts(request, publicId);
	expect(sent).toHaveLength(2);
	expect(sent[1].key).toBe(sent[0].key);
	expect(sent[1].body).toBe('{"expectedDocumentVersion":3,"expectedBusinessRevision":4}');
});

test('a Stripe.js failure keeps the payment and retries the same form deliberately', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, quotedSummary(), 'EMBEDDED');
	const stripe = await fakeStripe(page);
	stripe.fail = true;
	await open(page, publicId, token);
	await page.getByRole('button', { name: 'Pay deposit $240.00' }).click();
	const alert = page.getByTestId('embedded-error');
	await expect(alert).toContainText("We couldn't load the secure payment form", {
		timeout: 15_000
	});
	await expect(alert).toContainText('Trying again opens the same payment');
	await expect(page.getByTestId('pay')).toHaveCount(0);
	stripe.fail = false;
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect(page.locator('iframe[title="Secure checkout (test)"]')).toBeVisible();
	expect(await posts(request, publicId)).toHaveLength(1); // no new authorization
});

test('each attempt keeps its own mode across a configuration switch', async ({ page, request }) => {
	// An embedded attempt stays embedded after commerce switches back to hosted.
	const embedded = await scenario(request, quotedSummary(), 'EMBEDDED');
	await fakeStripe(page);
	await open(page, embedded.publicId, embedded.token);
	await page.getByRole('button', { name: 'Pay deposit $240.00' }).click();
	await expect(page.locator('iframe[title="Secure checkout (test)"]')).toBeVisible();
	await page.getByRole('button', { name: 'Back to booking overview' }).click();
	await update(request, embedded.publicId, { uiMode: 'HOSTED' });
	await page.getByRole('button', { name: 'Continue your payment' }).click();
	await expect(page.locator('iframe[title="Secure checkout (test)"]')).toBeVisible();
	expect(page.url()).not.toContain('checkout.stripe.com');

	// A legacy hosted answer (no uiMode, during a deploy) still goes to Stripe-hosted Checkout.
	const legacy = await scenario(request, quotedSummary(), 'LEGACY');
	await page.route('https://checkout.stripe.com/**', (route) =>
		route.fulfill({ contentType: 'text/html', body: '<title>Hosted (test)</title>Hosted' })
	);
	await open(page, legacy.publicId, legacy.token);
	await page.getByRole('button', { name: 'Pay deposit $240.00' }).click();
	await expect(page).toHaveURL(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
});

test('delayed reconciliation keeps waiting without enabling another payment', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, quotedSummary(), 'EMBEDDED');
	await fakeStripe(page);
	await open(page, publicId, token);
	await page.getByRole('button', { name: 'Pay deposit $240.00' }).click();
	await expect(page.locator('iframe[title="Secure checkout (test)"]')).toBeVisible();
	await completeInStripe(page);
	await expect(page.getByTestId('payment-notice')).toContainText('Confirming your payment');
	await expect(page.getByTestId('polling-status')).toHaveText('Checking for updates…');
	await page.waitForTimeout(2500); // at least one poll still shows the payment underway
	await expect(page.getByTestId('payment-notice')).toContainText('Confirming your payment');
	await expect(page.getByTestId('pay')).toHaveCount(0);
	await expect(page.getByTestId('recover-payment')).toHaveCount(0);
	expect(await posts(request, publicId)).toHaveLength(1);
	const reads = (await stubState(request, publicId)).calls.filter((c) => c.method === 'GET');
	expect(reads.length).toBeGreaterThanOrEqual(3);
});

test('a partial Invoice payment updates the balance; paying again is a new decision', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, bookedSummary(), 'EMBEDDED');
	await fakeStripe(page);
	await open(page, publicId, token);
	await page.getByRole('radio', { name: 'A different amount' }).check();
	await page.getByLabel('Amount (USD)').fill('100');
	await page.getByRole('button', { name: 'Pay $100.00' }).click();
	const panel = page.getByTestId('embedded-checkout');
	await expect(panel.getByTestId('embedded-amount')).toHaveText('$100.00');
	await expect(panel).toContainText('Payment toward Invoice v8');
	await completeInStripe(page);
	await expect(page.getByTestId('payment-notice')).toContainText('Confirming your payment');
	await update(request, publicId, {
		summary: bookedSummary({
			paidAmount: '340.00',
			balance: '860.00',
			requiredAmount: '860.00',
			history: [
				{ amount: '240.00', refundedAmount: '0.00', receivedAt: '2027-03-01T18:00:00Z' },
				{ amount: '100.00', refundedAmount: '0.00', receivedAt: '2027-04-01T18:00:00Z' }
			]
		})
	});
	await expect(page.getByTestId('payment-notice')).toContainText(
		'Payment received. Your remaining balance is $860.00.',
		{ timeout: 15_000 }
	);
	await expect(page.getByRole('button', { name: 'Pay $860.00' })).toBeEnabled();
	expect(await posts(request, publicId)).toHaveLength(1); // nothing started on its own
	await page.getByRole('button', { name: 'Pay $860.00' }).click();
	await expect(page.getByTestId('embedded-amount')).toHaveText('$860.00');
	const sent = await posts(request, publicId);
	expect(sent).toHaveLength(2);
	expect(sent[1].key).not.toBe(sent[0].key);
	expect(sent[0].body).toContain('"amountMinor":10000');
	expect(sent[1].body).toBe('{"expectedDocumentVersion":6,"expectedBusinessRevision":8}');
});

test('the payment form is keyboard reachable and fits without horizontal scroll', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, quotedSummary(), 'EMBEDDED');
	await fakeStripe(page);
	await open(page, publicId, token);
	await page.getByRole('button', { name: 'Pay deposit $240.00' }).focus();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('heading', { name: 'Complete your payment' })).toBeFocused();
	await expect(page.locator('iframe[title="Secure checkout (test)"]')).toBeVisible();
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(0);
	const frame = await page.locator('iframe[title="Secure checkout (test)"]').boundingBox();
	const viewport = page.viewportSize()!;
	expect(frame!.x).toBeGreaterThanOrEqual(0);
	expect(frame!.x + frame!.width).toBeLessThanOrEqual(viewport.width);
	const back = page.getByRole('button', { name: 'Back to booking overview' });
	expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	await back.focus();
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('embedded-checkout')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Continue your payment' })).toBeVisible();
});

test('a staff amendment while the form is open removes it; checking reuses the same key', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, bookedSummary(), 'EMBEDDED');
	await fakeStripe(page);
	await open(page, publicId, token);
	await page.getByRole('radio', { name: 'A different amount' }).check();
	await page.getByLabel('Amount (USD)').fill('200');
	await page.getByRole('button', { name: 'Pay $200.00' }).click();
	await expect(page.locator('iframe[title="Secure checkout (test)"]')).toBeVisible();

	// Staff publishes Invoice v9 while the original Session stays open (still underway).
	const amended = bookedSummary({
		document: { ...bookedSummary().document, version: 7, businessRevision: 9 },
		balance: '1060.00',
		requiredAmount: '1060.00'
	});
	await update(request, publicId, { summary: underway(amended) });
	const notice = page.getByTestId('payment-notice');
	await expect(notice).toContainText("Your booking's payment details have changed", {
		timeout: 15_000
	});
	await expect(page.getByTestId('embedded-checkout')).toHaveCount(0);
	await expect(page.locator('iframe')).toHaveCount(0);
	expect(await stripeTest(page)).toMatchObject({ destroys: 1, live: 0 });
	await expect(notice).not.toContainText(/cancel|expired|refund|not charged/i);
	await expect(page.getByTestId('document-label')).toContainText('Invoice v9');
	await expect(page.getByTestId('invalidated-payment')).toContainText('$200.00');
	await expect(page.getByTestId('pay')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Continue your payment' })).toHaveCount(0);

	// The deliberate check resends the original command; the stale form never comes back.
	await page.getByRole('button', { name: 'Check previous payment', exact: true }).click();
	await expect.poll(async () => (await posts(request, publicId)).length).toBe(2);
	const [first, check] = await posts(request, publicId);
	expect(check.key).toBe(first.key);
	expect(check.body).toBe(first.body);
	expect(first.body).toBe(
		'{"expectedDocumentVersion":6,"expectedBusinessRevision":8,"amountMinor":20000}'
	);
	await expect(notice).toContainText("Your booking's payment details have changed");
	await expect(page.getByTestId('embedded-checkout')).toHaveCount(0);
	expect(await stripeTest(page)).toMatchObject({ creates: 1, live: 0 });
});
