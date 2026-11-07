import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { join } from 'node:path';
import { bookedSummary, quotedSummary } from '../../src/lib/payments/testing/fixtures.js';

/*
 * On-page Checkout on /pay, end to end against the commerce stub. Stripe.js is replaced by
 * a routed fake on https://js.stripe.com (loaded through the real @stripe/stripe-js loader), whose
 * placeholder iframe also comes from js.stripe.com so the page's frame-src policy is exercised.
 * Stripe's real card form is never automated here; see the manual test-mode acceptance runbook.
 */

const stub = `http://127.0.0.1:${process.env.PAYMENTS_STUB_PORT ?? '4031'}`;
type Summary = ReturnType<typeof quotedSummary>;
type UiMode = 'HOSTED' | 'EMBEDDED' | 'ELEMENTS' | 'LEGACY';
type Call = { method: string; url: string; key?: string; body?: string };

async function scenario(
	request: APIRequestContext,
	summary: Summary,
	uiMode: UiMode,
	restart = false
) {
	const response = await request.post(`${stub}/__test__/scenario`, {
		data: { summary, uiMode, restart }
	});
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
		attempts: { id: string; state: string; replacedAttemptId?: string }[];
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
				// Exactly the secret commerce issued must arrive (format is Stripe's business).
				if (typeof secret !== 'string' || !secret.startsWith('cs_test_') || !secret.includes('#'))
					throw new Error('invalid client secret');
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
async function fakeStripe(page: Page, additionalScript = '') {
	const state = { fail: false, requests: [] as string[] };
	await page.route('https://js.stripe.com/**', async (route) => {
		const url = route.request().url();
		state.requests.push(url);
		if (state.fail) return route.abort('blockedbyclient');
		if (/\/stripe\.js(\?|$)/.test(url))
			return route.fulfill({
				contentType: 'text/javascript',
				body: FAKE_STRIPE_JS + additionalScript
			});
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
	await expect(panel).toContainText("Deposit for your Fiona's Ice Cream booking");
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
	await expect(page.getByTestId('document-label')).toHaveText('Invoice');
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
	await expect(panel).toContainText('Payment toward your Invoice');
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
	await expect(page.getByTestId('document-label')).toHaveText('Invoice');
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

// The fake consumes the actual Appearance API config and font in its iframes. Its fields
// contain placeholders only, and its confirm function never contacts a provider.
function elementsScript(
	cents: number | number[],
	fail = false,
	wallets: { applePay?: boolean; googlePay?: boolean } = {}
) {
	return `
	(() => {
		const embedded = window.Stripe;
		const t = window.__elementsTest = { creates: 0, destroys: 0, confirms: 0, fail: ${fail}, decline: false, uncertain: false };
		const availablePaymentMethods = ${JSON.stringify(wallets)};
		const wallet = window.__walletMock = { failed: 0, confirmed: [], cancel: null, authorize: null };
		window.Stripe = (key) => ({
			...embedded(key),
			initCheckoutElementsSdk({ clientSecret, elementsOptions }) {
				if (!clientSecret.startsWith('cs_test_')) throw new Error('invalid test configuration');
				t.creates++;
				const values = { contact: false, payment: false };
				const { appearance, fonts: [font] } = elementsOptions;
				const v = appearance.variables;
				let change;
				const getSession = () => ({
					currency: 'usd',
					minorUnitsAmountDivisor: 100,
					total: { total: { minorUnitsAmount: ${Array.isArray(cents) ? `(${JSON.stringify(cents)})[t.creates - 1]` : cents}, amount: 'untrusted display amount' } },
					status: { type: 'open' },
					canConfirm: values.contact && values.payment
				});
				function element(kind, markup, height) {
					const events = {};
					let frame;
					return {
						on(name, callback) { events[name] = callback; },
						mount(target) {
							frame = document.createElement('iframe');
							frame.title = kind === 'contact' ? 'Stripe contact details (mock)' : 'Stripe payment details (mock)';
							frame.style.cssText = 'display:block;width:100%;border:0;height:' + height + 'px';
							frame.srcdoc = '<!doctype html><style>@font-face{font-family:Poppins;src:' + font.src +
								'} body{margin:0;color:' + v.colorText + ';background:' + v.colorBackground +
								';font:14px ' + v.fontFamily + '} label{display:block;margin-bottom:5px}' +
								'input{box-sizing:border-box;font:16px ' + v.fontFamily +
								';color:' + v.colorText + ';width:100%;padding:10px 12px;background:' + v.colorBackground +
								';border:1px solid ' + appearance.rules['.Input'].borderColor + ';border-radius:' + v.borderRadius +
								'} input:focus{outline:2px solid ' + v.colorPrimary + '}.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}</style>' + markup;
							frame.onload = async () => {
								const doc = frame.contentDocument;
								await doc.fonts.load('16px Poppins');
								doc.querySelector('input').addEventListener('input', (event) => {
									values[kind] = event.target.checkValidity();
									change?.(getSession());
								});
								events.ready?.();
							};
							target.appendChild(frame);
						},
						destroy() { t.destroys++; frame?.remove(); }
					};
				}
				return {
					on(_event, fn) { change = fn; },
					createContactDetailsElement() {
						return element('contact', '<label for="email">Email address</label><input id="email" type="email" placeholder="you@example.com" required>', 76);
					},
					createPaymentElement() {
						return element('payment', '<label for="number">Card number</label><input id="number" placeholder="Card number" required>' +
							'<div class="pair"><div><label for="expiry">Expiration</label><input id="expiry" placeholder="MM / YY"></div>' +
							'<div><label for="code">Security code</label><input id="code" placeholder="CVC"></div></div>', 166);
					},
					createExpressCheckoutElement(options) {
						const events = {};
						let frame;
						wallet.cancel = () => events.cancel?.({ elementType: 'expressCheckout' });
						wallet.authorize = (type) => events.confirm?.({
							expressPaymentType: type,
							billingDetails: { email: 'wallet@example.test' },
							paymentFailed() { wallet.failed++; }
						});
						return {
							on(name, callback) { events[name] = callback; },
							mount(target) {
								const buttons = [
									['apple_pay', 'Apple Pay', availablePaymentMethods.applePay],
									['google_pay', 'Google Pay', availablePaymentMethods.googlePay]
								].filter(([, , available]) => available);
								if (buttons.length === 0) {
									events.ready?.({ availablePaymentMethods: undefined });
									return;
								}
								frame = document.createElement('iframe');
								frame.title = 'Stripe wallet buttons (mock)';
								frame.style.cssText = 'display:block;width:100%;border:0;height:' + options.buttonHeight + 'px';
								frame.srcdoc = '<!doctype html><style>body{margin:0;display:flex;gap:8px}' +
									'button{flex:1;min-width:0;border:0;border-radius:' + v.borderRadius +
									';background:#171717;color:white;font:600 15px system-ui;height:' + options.buttonHeight + 'px}</style>' +
									buttons.map(([type, label]) => '<button data-type="' + type + '">' + label + ' (mock)</button>').join('');
								frame.onload = () => {
									for (const button of frame.contentDocument.querySelectorAll('button')) {
										button.onclick = () => wallet.authorize(button.dataset.type);
									}
									events.ready?.({ availablePaymentMethods });
								};
								target.appendChild(frame);
							},
							destroy() { frame?.remove(); }
						};
					},
					async loadActions() {
						if (t.fail) return { type: 'error', error: { message: 'Private test load failure' } };
						return { type: 'success', actions: {
							getSession,
							async validateElements() { return { type: 'success', session: getSession() }; },
							async confirm({ redirect, expressCheckoutConfirmEvent }) {
								if (redirect !== 'if_required') throw new Error('Unexpected redirect option');
								if (expressCheckoutConfirmEvent) wallet.confirmed.push(expressCheckoutConfirmEvent.expressPaymentType);
								t.confirms++;
								if (t.uncertain) return { type: 'error', error: { code: null, message: 'Private test error' } };
								return t.decline
									? { type: 'error', error: { code: 'paymentFailed', message: 'Private test decline' } }
									: { type: 'success', session: getSession() };
							}
						} };
					}
				};
			}
		});
		window.Stripe.version = embedded.version;
	})();
	`;
}

type ElementsTest = {
	creates: number;
	destroys: number;
	confirms: number;
	fail: boolean;
	decline: boolean;
	uncertain: boolean;
};
const elementsState = (page: Page) =>
	page.evaluate(() => (window as unknown as { __elementsTest: ElementsTest }).__elementsTest);

async function fakeFields(page: Page) {
	await page
		.frameLocator('iframe[title="Stripe contact details (mock)"]')
		.getByLabel('Email address')
		.fill('checkout@example.test');
	await page
		.frameLocator('iframe[title="Stripe payment details (mock)"]')
		.getByLabel('Card number')
		.fill('Mock payment details');
}

test('restarts an abandoned $250 Elements checkout for $150 with a fresh form', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, bookedSummary(), 'ELEMENTS', true);
	await fakeStripe(page, elementsScript([25000, 15000, 15000]));
	await open(page, publicId, token);
	await page.getByRole('radio', { name: 'A different amount' }).check();
	await page.getByLabel('Amount (USD)').fill('250');
	await page.getByTestId('pay').click();
	await expect(page.getByTestId('elements-amount')).toHaveText('$250.00');
	await fakeFields(page);
	await expect(page.getByRole('button', { name: 'Pay $250.00' })).toBeEnabled();
	await page.getByRole('button', { name: 'Back to booking overview' }).click();
	await expect(page.getByTestId('elements-checkout')).toHaveCount(0);
	expect(await elementsState(page)).toMatchObject({ destroys: 2, confirms: 0 });
	await expect(page.getByRole('button', { name: 'Continue previous payment' })).toBeVisible();
	await page.getByTestId('review-restart').click();
	await page.getByRole('radio', { name: 'A different amount' }).check();
	await page.getByLabel('Amount (USD)').fill('150');
	const before = await stubState(request, publicId);
	expect(before.attempts).toEqual([{ id: expect.any(String), state: 'OPEN' }]);
	expect(await posts(request, publicId)).toHaveLength(1);

	// The replacement authorizes successfully, but Stripe's form fails to initialize once.
	await page.evaluate(() => {
		(window as unknown as { __elementsTest: ElementsTest }).__elementsTest.fail = true;
	});
	await page.getByTestId('submit-restart').click();
	const panel = page.getByTestId('elements-checkout');
	await expect(panel.getByRole('alert')).toContainText("We couldn't load the secure payment form");
	const [previous, replacement] = (await stubState(request, publicId)).attempts;
	expect(previous.state).toBe('EXPIRED');
	expect(replacement).toMatchObject({ state: 'OPEN', replacedAttemptId: previous.id });
	await page.evaluate(() => {
		(window as unknown as { __elementsTest: ElementsTest }).__elementsTest.fail = false;
	});
	await panel.getByRole('button', { name: 'Check previous payment' }).click();
	await expect(panel.getByTestId('elements-amount')).toHaveText('$150.00');
	const pay = panel.getByRole('button', { name: 'Pay $150.00' });
	await expect(pay).toBeDisabled();
	await fakeFields(page);
	await expect(pay).toBeEnabled();
	expect(await elementsState(page)).toMatchObject({ creates: 3, confirms: 0 });
	const [original, restart, recovery] = await posts(request, publicId);
	expect(restart.key).not.toBe(original.key);
	expect(JSON.parse(restart.body!)).toMatchObject({
		amountMinor: 15000,
		restartToken: expect.any(String)
	});
	expect(recovery).toEqual(restart);
	expect((await stubState(request, publicId)).attempts).toHaveLength(2);
});

test('a second tab restarts the Invoice and recovers the replacement after its response is lost', async ({
	page,
	context,
	request
}) => {
	const { publicId, token } = await scenario(request, bookedSummary(), 'EMBEDDED', true);
	await fakeStripe(page);
	await open(page, publicId, token);
	await page.getByRole('radio', { name: 'A different amount' }).check();
	await page.getByLabel('Amount (USD)').fill('250');
	await page.getByTestId('pay').click();
	await expect(page.getByTestId('embedded-amount')).toHaveText('$250.00');
	await page.getByRole('button', { name: 'Back to booking overview' }).click();

	// Hold this tab's restart in transit so the second tab can replace the same target first.
	let releaseFirstTab!: () => void;
	const firstTabCanSend = new Promise<void>((resolve) => (releaseFirstTab = resolve));
	await page.route('**/api/payments/*/checkout-sessions', async (route) => {
		await firstTabCanSend;
		await route.continue();
	});
	await page.getByTestId('review-restart').click();
	await page.getByTestId('submit-restart').click();

	const secondTab = await context.newPage();
	await fakeStripe(secondTab);
	await open(secondTab, publicId, token);
	await expect(
		secondTab.getByRole('button', { name: 'Continue previous payment', exact: true })
	).toHaveCount(0);
	await secondTab.getByTestId('review-restart').click();
	await secondTab.getByRole('radio', { name: 'A different amount' }).check();
	await secondTab.getByLabel('Amount (USD)').fill('150');
	await update(request, publicId, { replies: [{ dropAfterCommit: true }] });
	await secondTab.getByTestId('submit-restart').click();
	await expect(secondTab.getByTestId('embedded-amount')).toHaveText('$150.00');
	releaseFirstTab();
	await expect(page.getByTestId('payment-notice')).toContainText(
		'Your payment status just changed'
	);
	await expect(page.getByTestId('review-restart')).toBeVisible();
	const [original, restart, retry, competing] = await posts(request, publicId);
	expect(JSON.parse(original.body!)).not.toHaveProperty('restartToken');
	expect(restart.key).not.toBe(original.key);
	expect(retry).toEqual(restart);
	expect(competing.key).not.toBe(restart.key);
	expect(JSON.parse(competing.body!).restartToken).toBe(JSON.parse(restart.body!).restartToken);
	expect((await stubState(request, publicId)).attempts).toHaveLength(2);
	await expect(secondTab).toHaveURL(new RegExp(`/pay/${publicId}$`));
});

test('restarting a Quote deposit reviews the approved amount without amount options', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, quotedSummary(), 'EMBEDDED', true);
	await fakeStripe(page);
	await open(page, publicId, token);
	await page.getByTestId('pay').click();
	await expect(page.getByTestId('embedded-amount')).toHaveText('$240.00');
	await page.getByRole('button', { name: 'Back to booking overview' }).click();
	await page.getByTestId('review-restart').click();
	await expect(page.getByText('Approved deposit due')).toContainText('$240.00');
	await expect(page.getByRole('radio')).toHaveCount(0);
	await page.getByTestId('submit-restart').click();
	await expect(page.getByTestId('embedded-amount')).toHaveText('$240.00');
	const [original, restart] = await posts(request, publicId);
	expect(restart.key).not.toBe(original.key);
	expect(JSON.parse(restart.body!)).toMatchObject({ restartToken: expect.any(String) });
	expect(JSON.parse(restart.body!)).not.toHaveProperty('amountMinor');
});

test('Elements deposit stays pending until commerce records it', async ({ page, request }) => {
	const logs: string[] = [];
	page.on('console', (message) => logs.push(message.text()));
	page.on('pageerror', (error) => logs.push(error.message));
	const { publicId, token } = await scenario(request, quotedSummary(), 'ELEMENTS');
	const stripe = await fakeStripe(page, elementsScript(24000));
	const response = await open(page, publicId, token);
	const html = await response!.text();
	expect(stripe.requests).toEqual([]);
	await page.getByTestId('pay').focus();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('heading', { name: 'Complete your payment' })).toBeFocused();
	const pay = page.getByRole('button', { name: 'Pay $240.00' });
	await expect(pay).toBeDisabled();
	await expect(page.getByTestId('elements-amount')).toHaveText('$240.00');
	await fakeFields(page);
	await expect(pay).toBeEnabled();
	await pay.focus();
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('payment-notice')).toContainText('Confirming your payment');
	await expect(page.getByTestId('elements-checkout')).toHaveCount(0);
	await expect(page.getByTestId('stage-label')).toHaveText('Quote ready');
	expect(await elementsState(page)).toMatchObject({ confirms: 1, destroys: 2 });
	await update(request, publicId, { summary: bookedSummary() });
	await expect(page.getByTestId('payment-notice')).toContainText('Deposit received');
	expect(await posts(request, publicId)).toHaveLength(1);
	const [secret] = (await stubState(request, publicId)).secrets;
	for (const privateValue of [secret, 'checkout@example.test', 'Mock payment details']) {
		expect(html).not.toContain(privateValue);
		expect(await persisted(page, logs)).not.toContain(privateValue);
	}
	expect(html).not.toContain(token);
	await expect(page).toHaveURL(new RegExp(`/pay/${publicId}$`));
});

test('Elements verifies the full Invoice amount, with branded desktop and mobile fields', async ({
	page,
	request
}, testInfo) => {
	const summary = bookedSummary({
		document: { ...bookedSummary().document, totalAmount: '720.00' },
		balance: '480.00',
		requiredAmount: '480.00'
	});
	const { publicId, token } = await scenario(request, summary, 'ELEMENTS');
	await fakeStripe(page, elementsScript(48000));
	await open(page, publicId, token);
	await page.getByTestId('pay').click();
	await expect(page.getByTestId('elements-amount')).toHaveText('$480.00');
	const field = page
		.frameLocator('iframe[title="Stripe contact details (mock)"]')
		.getByLabel('Email address');
	expect(
		await field.evaluate((element) => {
			const doc = element.ownerDocument;
			return (
				[...doc.fonts].some((font) => font.family === 'Poppins' && font.status === 'loaded') &&
				doc.defaultView!.getComputedStyle(element).fontFamily.includes('Poppins')
			);
		})
	).toBe(true);
	await page.keyboard.press('Tab');
	await expect(field).toBeFocused();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
		page.viewportSize()!.width
	);
	const screenshotDir = process.env.PAYMENTS_SCREENSHOTS;
	if (screenshotDir) {
		await field.blur();
		const viewport = testInfo.project.name.startsWith('mobile') ? 'mobile' : 'desktop';
		if (viewport === 'desktop')
			await page.setViewportSize({ ...page.viewportSize()!, height: 1000 });
		const panel = page.getByTestId('elements-checkout');
		await panel.evaluate((element) => element.scrollIntoView({ block: 'center' }));
		await panel.screenshot({
			path: join(screenshotDir, `checkout-elements-${viewport}.png`),
			scale: 'css'
		});
	}
});

test('Elements resumes a partial Invoice payment after reload and handles a decline', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, bookedSummary(), 'ELEMENTS');
	await fakeStripe(page, elementsScript(10000));
	await open(page, publicId, token);
	await page.getByRole('radio', { name: 'A different amount' }).check();
	await page.getByLabel('Amount (USD)').fill('100');
	await page.getByTestId('pay').click();
	await expect(page.getByTestId('elements-amount')).toHaveText('$100.00');
	await page.getByRole('button', { name: 'Back to booking overview' }).click();
	await expect(page.getByRole('heading', { name: 'your booking' })).toBeFocused();
	await page.reload();
	await page.getByRole('button', { name: 'Continue your payment' }).click();
	await expect(page.getByTestId('elements-amount')).toHaveText('$100.00');
	await fakeFields(page);
	await page.evaluate(
		() => ((window as unknown as { __elementsTest: ElementsTest }).__elementsTest.decline = true)
	);
	const pay = page.getByRole('button', { name: 'Pay $100.00' });
	await pay.click();
	await expect(page.getByRole('alert')).toContainText('Your payment was declined');
	expect(await elementsState(page)).toMatchObject({ creates: 1, destroys: 0, confirms: 1 });
	await expect(page.getByRole('alert')).not.toContainText('Private test decline');
	await expect(pay).toBeEnabled();
	await page.evaluate(
		() => ((window as unknown as { __elementsTest: ElementsTest }).__elementsTest.decline = false)
	);
	await pay.click();
	await expect(page.getByTestId('payment-notice')).toContainText('Confirming your payment');
	await update(request, publicId, {
		summary: bookedSummary({ paidAmount: '340.00', balance: '860.00', requiredAmount: '860.00' })
	});
	await expect(page.getByTestId('payment-notice')).toContainText(
		'Your remaining balance is $860.00'
	);
	const [first, resumed] = await posts(request, publicId);
	expect(resumed.key).toBe(first.key);
	expect(resumed.body).toBe(first.body);
	expect(resumed.body).toContain('"amountMinor":10000');
});

test('Elements can check the same authorization after a loading failure', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, quotedSummary(), 'ELEMENTS');
	await fakeStripe(page, elementsScript(24000, true));
	await open(page, publicId, token);
	await page.getByTestId('pay').click();
	await expect(page.getByRole('alert')).toContainText("We couldn't load the secure payment form");
	await page.evaluate(
		() => ((window as unknown as { __elementsTest: ElementsTest }).__elementsTest.fail = false)
	);
	await page.getByRole('button', { name: 'Check previous payment' }).click();
	await expect(page.getByTestId('elements-amount')).toHaveText('$240.00');
	const [first, check] = await posts(request, publicId);
	expect(check.key).toBe(first.key);
	expect(check.body).toBe(first.body);
});

test('Elements checks and resumes the same OPEN Session after an uncertain confirmation and reload', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, quotedSummary(), 'ELEMENTS');
	await fakeStripe(page, elementsScript(24000));
	await open(page, publicId, token);
	await page.getByTestId('pay').click();
	await expect(page.getByTestId('elements-amount')).toHaveText('$240.00');
	await fakeFields(page);
	await page.evaluate(() => {
		(window as unknown as { __elementsTest: ElementsTest }).__elementsTest.uncertain = true;
	});
	const pay = page.getByRole('button', { name: 'Pay $240.00' });
	await pay.click();
	const notice = page.getByTestId('payment-notice');
	await expect(notice).toContainText("We couldn't confirm your payment status");
	await expect(page.getByTestId('elements-checkout')).toHaveCount(0);
	expect(await elementsState(page)).toMatchObject({ confirms: 1, destroys: 2 });
	expect(await posts(request, publicId)).toHaveLength(1);

	await page.reload();
	await expect(notice).toContainText("We couldn't confirm your payment status");
	const check = page.getByRole('button', { name: 'Check previous payment', exact: true });
	await update(request, publicId, { replies: [{ status: 504, body: { code: 'unavailable' } }] });
	await check.click();
	await expect.poll(async () => (await posts(request, publicId)).length).toBe(2);
	await expect(check).toBeEnabled();
	await expect(notice).toContainText("We couldn't confirm your payment status");
	await expect(page.getByTestId('elements-checkout')).toHaveCount(0);

	await check.click();
	await expect(page.getByTestId('elements-amount')).toHaveText('$240.00');
	await expect(pay).toBeDisabled();
	expect(await elementsState(page)).toMatchObject({ creates: 1, confirms: 0 });
	const sent = await posts(request, publicId);
	expect(sent).toHaveLength(3);
	expect(sent[1]).toEqual(sent[0]);
	expect(sent[2]).toEqual(sent[0]);
	expect((await stubState(request, publicId)).secrets).toHaveLength(1);

	await fakeFields(page);
	await pay.click();
	await expect(notice).toContainText('Confirming your payment');
	await update(request, publicId, { summary: bookedSummary() });
	await expect(notice).toContainText('Deposit received');
	expect(await posts(request, publicId)).toHaveLength(3);
});

test('an old Embedded attempt resumes after the switch and a fresh payment uses Elements', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, quotedSummary(), 'EMBEDDED');
	await fakeStripe(page, elementsScript(96000));
	await open(page, publicId, token);
	await page.getByTestId('pay').click();
	const embeddedFrame = page.locator('iframe[title="Secure checkout (test)"]');
	await expect(embeddedFrame).toBeVisible();
	await page.getByRole('button', { name: 'Back to booking overview' }).click();
	await update(request, publicId, { uiMode: 'ELEMENTS' });
	await page.getByRole('button', { name: 'Continue your payment' }).click();
	await expect(embeddedFrame).toBeVisible();
	await completeInStripe(page);
	await expect(page.getByTestId('payment-notice')).toContainText('Confirming your payment');
	await update(request, publicId, { summary: bookedSummary() });
	await expect(page.getByTestId('payment-notice')).toContainText('Deposit received');
	await page.getByTestId('pay').click();
	await expect(page.getByTestId('elements-amount')).toHaveText('$960.00');
	const [original, resumed, fresh] = await posts(request, publicId);
	expect(resumed.key).toBe(original.key);
	expect(fresh.key).not.toBe(original.key);
});

test('Elements preflight catches an amendment before Stripe can confirm', async ({
	page,
	request
}) => {
	const summary = bookedSummary();
	const { publicId, token } = await scenario(request, summary, 'ELEMENTS');
	await fakeStripe(page, elementsScript(96000));
	await open(page, publicId, token);
	await page.getByTestId('pay').click();
	await expect(page.getByTestId('elements-amount')).toHaveText('$960.00');
	await fakeFields(page);
	const pay = page.getByRole('button', { name: 'Pay $960.00' });
	await expect(pay).toBeEnabled();
	// Give the first read after the customer clicks Pay the amended summary.
	const amended = underway(
		bookedSummary({
			document: { ...summary.document, version: 7, businessRevision: 9 }
		})
	);
	await page.route(`**/api/payments/${publicId}`, (route) => route.fulfill({ json: amended }));
	await pay.click();
	await expect(page.getByTestId('payment-notice')).toContainText(
		"Your booking's payment details have changed"
	);
	await expect(page.getByTestId('elements-checkout')).toHaveCount(0);
	expect(await elementsState(page)).toMatchObject({ confirms: 0, destroys: 2 });
	await page.getByRole('button', { name: 'Check previous payment' }).click();
	await expect.poll(async () => (await posts(request, publicId)).length).toBe(2);
	const [first, check] = await posts(request, publicId);
	expect(check.key).toBe(first.key);
	expect(check.body).toBe(first.body);
	await expect(page.getByTestId('elements-checkout')).toHaveCount(0);
});

type WalletMock = {
	cancel(): void;
	authorize(type: 'apple_pay' | 'google_pay'): void;
	confirmed: string[];
	failed: number;
};

const walletFrame = (page: Page) =>
	page.frameLocator('iframe[title="Stripe wallet buttons (mock)"]');
const walletConfirmations = (page: Page) =>
	page.evaluate(() => (window as unknown as { __walletMock: WalletMock }).__walletMock.confirmed);

async function openWallets(
	page: Page,
	request: APIRequestContext,
	wallets = { applePay: true, googlePay: true }
) {
	const { publicId, token } = await scenario(request, quotedSummary(), 'ELEMENTS');
	await fakeStripe(page, elementsScript(24000, false, wallets));
	await open(page, publicId, token);
	await page.getByTestId('pay').click();
	await expect(page.getByTestId('elements-amount')).toHaveText('$240.00');
	return publicId;
}

for (const [name, applePay, googlePay] of [
	['Apple Pay only', true, false],
	['Google Pay only', false, true],
	['both wallets', true, true],
	['neither wallet', false, false]
] as const) {
	test(`Express Checkout displays ${name} using Stripe availability`, async ({
		page,
		request
	}, testInfo) => {
		await openWallets(page, request, { applePay, googlePay });
		const separator = page.getByText('or pay with card', { exact: true });
		if (applePay || googlePay) {
			await expect(separator).toBeVisible();
			await expect(walletFrame(page).getByRole('button', { name: 'Apple Pay (mock)' })).toHaveCount(
				applePay ? 1 : 0
			);
			await expect(
				walletFrame(page).getByRole('button', { name: 'Google Pay (mock)' })
			).toHaveCount(googlePay ? 1 : 0);
			for (const button of await walletFrame(page).getByRole('button').all()) {
				const bounds = (await button.boundingBox())!;
				expect(bounds.height).toBeGreaterThanOrEqual(44);
				expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
			}
		} else {
			await expect(separator).toHaveCount(0);
			await expect(page.getByTestId('elements-wallets')).toBeHidden();
		}
		await expect(page.getByRole('button', { name: 'Pay $240.00' })).toBeDisabled();
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			page.viewportSize()!.width
		);
		const screenshotDir = process.env.PAYMENTS_SCREENSHOTS;
		if (applePay && googlePay && screenshotDir) {
			const viewport = testInfo.project.name.startsWith('mobile') ? 'mobile' : 'desktop';
			await page.setViewportSize({ ...page.viewportSize()!, height: 1050 });
			const panel = page.getByTestId('elements-checkout');
			await panel.evaluate((element) => element.scrollIntoView({ block: 'center' }));
			await panel.screenshot({
				path: join(screenshotDir, `checkout-wallets-${viewport}.png`),
				scale: 'css'
			});
		}
	});
}

test('Express Checkout settles from the ledger and blocks a competing card confirmation', async ({
	page,
	request
}) => {
	const publicId = await openWallets(page, request);
	const pay = page.getByRole('button', { name: 'Pay $240.00' });
	await fakeFields(page);
	await expect(pay).toBeEnabled();
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route(`**/api/payments/${publicId}`, async (route) => {
		await held;
		await route.continue();
	});
	try {
		await walletFrame(page).getByRole('button', { name: 'Apple Pay (mock)' }).click();
		await expect(page.getByRole('button', { name: 'Submitting payment…' })).toBeDisabled();
		await page
			.locator('form')
			.filter({ has: page.getByTestId('elements-contact') })
			.dispatchEvent('submit');
		await page.evaluate(() =>
			(window as unknown as { __walletMock: WalletMock }).__walletMock.authorize('google_pay')
		);
		expect(await walletConfirmations(page)).toEqual([]);
	} finally {
		release();
	}
	await expect(page.getByTestId('payment-notice')).toContainText('Confirming your payment');
	expect(await walletConfirmations(page)).toEqual(['apple_pay']);
	expect(await elementsState(page)).toMatchObject({ creates: 1, confirms: 1 });
	await expect(page.getByTestId('elements-checkout')).toHaveCount(0);
	await expect(page.getByTestId('stage-label')).toHaveText('Quote ready');
	await update(request, publicId, { summary: bookedSummary() });
	await expect(page.getByTestId('payment-notice')).toContainText('Deposit received');
	const authorization = await posts(request, publicId);
	expect(authorization).toHaveLength(1);
	expect(authorization[0].body).not.toContain('wallet@example.test');
	expect(await persisted(page, [])).not.toContain('wallet@example.test');
});

test('Express Checkout cancellation and decline leave the same Session available for card', async ({
	page,
	request
}) => {
	const publicId = await openWallets(page, request);
	await page.evaluate(() => {
		const mock = window as unknown as { __walletMock: WalletMock; __elementsTest: ElementsTest };
		mock.__walletMock.cancel();
		mock.__elementsTest.decline = true;
	});
	expect(await elementsState(page)).toMatchObject({ confirms: 0 });
	await walletFrame(page).getByRole('button', { name: 'Google Pay (mock)' }).click();
	await expect(page.getByRole('alert')).toContainText('Your payment was declined');
	expect(await walletConfirmations(page)).toEqual(['google_pay']);
	await expect(page.getByRole('button', { name: 'Pay $240.00' })).toBeDisabled();
	await fakeFields(page);
	await page.evaluate(() => {
		(window as unknown as { __elementsTest: ElementsTest }).__elementsTest.decline = false;
	});
	await page.getByRole('button', { name: 'Pay $240.00' }).click();
	await expect(page.getByTestId('payment-notice')).toContainText('Confirming your payment');
	expect(await elementsState(page)).toMatchObject({ creates: 1, confirms: 2 });
	expect(await posts(request, publicId)).toHaveLength(1);
});

test('Express Checkout uncertainty recovers only the original authorization', async ({
	page,
	request
}) => {
	const publicId = await openWallets(page, request);
	await page.evaluate(() => {
		(window as unknown as { __elementsTest: ElementsTest }).__elementsTest.uncertain = true;
	});
	await walletFrame(page).getByRole('button', { name: 'Google Pay (mock)' }).click();
	await expect(page.getByTestId('elements-checkout')).toHaveCount(0);
	const check = page.getByRole('button', { name: 'Check previous payment' });
	await expect(check).toBeVisible();
	expect(await posts(request, publicId)).toHaveLength(1);
	await check.click();
	await expect(walletFrame(page).getByRole('button', { name: 'Google Pay (mock)' })).toBeVisible();
	const [first, recovery] = await posts(request, publicId);
	expect(recovery.key).toBe(first.key);
	expect(recovery.body).toBe(first.body);
	expect(await elementsState(page)).toMatchObject({ creates: 2, confirms: 1 });
});

test('Express Checkout invalidates both payment paths when booking changes during wallet authorization', async ({
	page,
	request
}) => {
	const publicId = await openWallets(page, request);
	await expect(walletFrame(page).getByRole('button', { name: 'Apple Pay (mock)' })).toBeVisible();
	const summary = quotedSummary();
	const amended = underway(
		quotedSummary({
			document: { ...summary.document, version: 7, businessRevision: 9 }
		})
	);
	await page.route(`**/api/payments/${publicId}`, (route) => route.fulfill({ json: amended }));
	await walletFrame(page).getByRole('button', { name: 'Apple Pay (mock)' }).click();
	await expect(page.getByTestId('payment-notice')).toContainText(
		"Your booking's payment details have changed"
	);
	await expect(page.getByTestId('elements-checkout')).toHaveCount(0);
	expect(await walletConfirmations(page)).toEqual([]);
	await page.getByRole('button', { name: 'Check previous payment' }).click();
	await expect.poll(async () => (await posts(request, publicId)).length).toBe(2);
	const [first, recovery] = await posts(request, publicId);
	expect(recovery.key).toBe(first.key);
	expect(recovery.body).toBe(first.body);
	await expect(page.getByTestId('elements-checkout')).toHaveCount(0);
});
