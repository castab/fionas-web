import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { bookedSummary, quotedSummary } from '../../src/lib/payments/testing/fixtures.js';

const stub = `http://127.0.0.1:${process.env.PAYMENTS_STUB_PORT ?? '4031'}`;
type Summary = ReturnType<typeof quotedSummary>;
type Reply = { status?: number; body?: unknown; delay?: number; replace?: boolean } | 'drop';
type Call = {
	method: string;
	url: string;
	token: string[];
	cookie: string | null;
	authorization: string | null;
	key?: string;
	body?: string;
};

async function scenario(request: APIRequestContext, summary: Summary, replies: Reply[] = []) {
	const response = await request.post(`${stub}/__test__/scenario`, { data: { summary, replies } });
	expect(response.ok()).toBe(true);
	return (await response.json()) as { publicId: string; token: string };
}
async function update(request: APIRequestContext, publicId: string, data: unknown) {
	const response = await request.post(`${stub}/__test__/scenario/${publicId}`, { data });
	expect(response.ok()).toBe(true);
	return (await response.json()) as { token: string };
}
async function calls(request: APIRequestContext, publicId: string): Promise<Call[]> {
	return (await (await request.get(`${stub}/__test__/scenario/${publicId}`)).json()).calls;
}
const posts = async (request: APIRequestContext, publicId: string) =>
	(await calls(request, publicId)).filter((c) => c.method === 'POST');

/** Simulated Stripe-hosted Checkout: its buttons redirect back exactly as commerce configures. */
async function simulateStripe(page: Page, publicId: string) {
	await page.route('https://checkout.stripe.com/**', async (route) => {
		const base = test.info().project.use.baseURL;
		await route.fulfill({
			contentType: 'text/html',
			body: `<!doctype html><title>Stripe Checkout (test)</title><h1>Stripe test checkout</h1>
				<a href="${base}/pay/${publicId}?checkout=returned">Complete payment</a>
				<a href="${base}/pay/${publicId}?checkout=cancelled">Back to Fiona's</a>`
		});
	});
}

const open = (page: Page, publicId: string, token?: string) =>
	page.goto(`/pay/${publicId}${token ? `#${token}` : ''}`);

const inProgress = (summary: Summary, recovery = true) => ({
	...summary,
	canPay: false,
	unavailableReason: 'PAYMENT_IN_PROGRESS',
	paymentInProgress: true,
	checkoutRecoveryAvailable: recovery
});

test('a new link captures the bearer, cleans the URL and shows the deposit', async ({
	page,
	request,
	context
}) => {
	const { publicId, token } = await scenario(request, quotedSummary());
	await context.addCookies([
		{ name: 'site_pref', value: 'public-cookie', url: test.info().project.use.baseURL! }
	]);
	const response = await open(page, publicId, token);
	const html = await response!.text();
	expect(html).not.toContain(token);
	expect(response!.headers()['cache-control']).toBe('no-store');
	expect(response!.headers()['referrer-policy']).toBe('no-referrer');
	expect(response!.headers()['x-robots-tag']).toBe('noindex, nofollow');
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');

	await expect(page.getByTestId('pay-page')).toBeVisible();
	await expect(page.getByTestId('stage-label')).toHaveText('Quote ready');
	await expect(page.getByTestId('document-label')).toHaveText('Quote');
	await expect(page.getByTestId('event-date')).toHaveText('Saturday, May 1, 2027');
	await expect(page.getByTestId('figure-total')).toContainText('$1,200.00');
	await expect(page.getByTestId('figure-paid')).toContainText('$0.00');
	await expect(page.getByTestId('figure-balance')).toContainText('$1,200.00');
	await expect(page.getByTestId('deposit-amount')).toHaveText('$240.00');
	await expect(page.getByRole('button', { name: 'Pay deposit $240.00' })).toBeEnabled();
	await expect(page.getByLabel(/amount/i)).toHaveCount(0); // no partial deposits
	expect(page.url()).toBe(`${test.info().project.use.baseURL}/pay/${publicId}`);
	expect(await page.evaluate(() => location.hash)).toBe('');
	expect(
		await page.evaluate((id) => sessionStorage.getItem(`fionas.pay.${id}.token`), publicId)
	).toBe(token);
	expect(await page.evaluate(() => localStorage.length)).toBe(0);
	expect(await page.evaluate(() => document.cookie)).not.toContain(token);

	const [read] = await calls(request, publicId);
	expect(read.url).toBe(`/public/payments/${publicId}`);
	expect(read.token).toEqual([token]);
	expect(read.cookie).toBeNull();
	expect(read.authorization).toBeNull();
});

test('paying the exact deposit goes to Stripe; returning confirms only from commerce', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, quotedSummary());
	await simulateStripe(page, publicId);
	await open(page, publicId, token);
	await page.getByRole('button', { name: 'Pay deposit $240.00' }).click();
	await expect(page).toHaveURL(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
	const [post] = await posts(request, publicId);
	expect(post.body).toBe('{"expectedDocumentVersion":3,"expectedBusinessRevision":4}');
	expect(post.key).toMatch(/^[0-9a-f-]{36}$/);
	expect(post.cookie).toBeNull();

	await page.getByRole('link', { name: 'Complete payment' }).click();
	await expect(page).toHaveURL(new RegExp(`/pay/${publicId}$`));
	// The webhook hasn't landed: "returned" alone never means paid.
	await expect(page.getByTestId('payment-notice')).toContainText('Confirming your payment');
	await expect(page.getByText('Deposit received')).toHaveCount(0);
	await expect(page.getByTestId('polling-status')).toHaveText('Checking for updates…');
	expect(
		await page.evaluate((id) => sessionStorage.getItem(`fionas.pay.${id}.checkout`), publicId)
	).not.toContain('checkout.stripe.com');

	await update(request, publicId, {
		summary: bookedSummary({
			history: [{ amount: '240.00', refundedAmount: '0.00', receivedAt: '2027-03-01T18:00:00Z' }]
		})
	});
	await expect(page.getByTestId('payment-notice')).toContainText(
		'Deposit received. Your booking is confirmed.'
	);
	await expect(page.getByTestId('payment-notice')).toContainText(
		'Your remaining balance is $960.00.'
	);
	await expect(page.getByTestId('stage-label')).toHaveText('Booked');
	await expect(page.getByTestId('document-label')).toHaveText('Invoice');
	await expect(page.getByTestId('payment-overview')).not.toContainText(
		/Quote v\d|Invoice v\d|Booked from/
	);
	await expect(page.getByTestId('payment-history')).toContainText('$240.00');
	await expect(page.getByRole('progressbar', { name: 'Payment progress' })).toHaveAttribute(
		'aria-valuenow',
		'20'
	);
});

test('a cancelled Checkout that is still open resumes with the same key, never a new one', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, quotedSummary());
	await simulateStripe(page, publicId);
	await open(page, publicId, token);
	await page.getByRole('button', { name: 'Pay deposit $240.00' }).click();
	await expect(page).toHaveURL(/checkout\.stripe\.com/);
	await page.getByRole('link', { name: "Back to Fiona's" }).click();
	await expect(page.getByTestId('payment-notice')).toContainText('You returned from checkout');
	await expect(page.getByTestId('pay')).toHaveCount(0);
	await page.getByRole('button', { name: 'Check previous payment and continue' }).click();
	await expect(page).toHaveURL(/checkout\.stripe\.com/);
	const sent = await posts(request, publicId);
	expect(sent).toHaveLength(2);
	expect(sent[1].key).toBe(sent[0].key);
	expect(sent[1].body).toBe(sent[0].body);
});

test('a booked Invoice pays the full balance or a validated partial amount', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, bookedSummary());
	await simulateStripe(page, publicId);
	await open(page, publicId, token);
	await expect(page.getByTestId('stage-label')).toHaveText('Booked');
	await expect(page.getByRole('radio', { name: /Remaining balance/ })).toBeChecked();
	await expect(page.getByRole('button', { name: 'Pay $960.00' })).toBeVisible();
	await page.getByRole('radio', { name: 'A different amount' }).check();
	const amount = page.getByLabel('Amount (USD)');
	const pay = page.getByTestId('pay');
	for (const [value, message] of [
		['10.123', 'no more than two decimal places'],
		['0.25', 'at least $0.50'],
		['960.01', 'more than your remaining balance of $960.00'],
		['ten', 'Enter a dollar amount']
	]) {
		await amount.fill(value);
		await pay.click();
		await expect(page.getByRole('alert')).toContainText(message);
		await expect(amount).toHaveAttribute('aria-invalid', 'true');
	}
	expect(await posts(request, publicId)).toHaveLength(0);
	await amount.fill('100');
	await expect(page.getByRole('button', { name: 'Pay $100.00' })).toBeVisible();
	await page.getByRole('button', { name: 'Pay $100.00' }).click();
	await expect(page).toHaveURL(/checkout\.stripe\.com/);
	const [post] = await posts(request, publicId);
	expect(post.body).toBe(
		'{"expectedDocumentVersion":6,"expectedBusinessRevision":8,"amountMinor":10000}'
	);
	await page.getByRole('link', { name: 'Complete payment' }).click();
	await update(request, publicId, {
		summary: bookedSummary({ paidAmount: '340.00', balance: '860.00', requiredAmount: '860.00' })
	});
	await expect(page.getByTestId('payment-notice')).toContainText(
		'Payment received. Your remaining balance is $860.00.'
	);
});

test('a full Invoice balance sends no amount', async ({ page, request }) => {
	const { publicId, token } = await scenario(request, bookedSummary({ lifecycle: 'SERVED' }));
	await simulateStripe(page, publicId);
	await open(page, publicId, token);
	await expect(page.getByTestId('stage-label')).toHaveText('Event served');
	await page.getByRole('button', { name: 'Pay $960.00' }).click();
	await expect(page).toHaveURL(/checkout\.stripe\.com/);
	expect((await posts(request, publicId))[0].body).toBe(
		'{"expectedDocumentVersion":6,"expectedBusinessRevision":8}'
	);
});

test('a balance above the Stripe maximum requires a smaller payment', async ({ page, request }) => {
	const { publicId, token } = await scenario(
		request,
		bookedSummary({ requiredAmount: '1500000.00', balance: '1500000.00' })
	);
	await open(page, publicId, token);
	await expect(page.getByRole('radio', { name: /Remaining balance/ })).toBeDisabled();
	await expect(page.getByText('Online payments are limited to $999,999.99 each')).toBeVisible();
	await page.getByLabel('Amount (USD)').fill('1000000');
	await page.getByTestId('pay').click();
	await expect(page.getByRole('alert')).toContainText('at most $999,999.99');
});

test('an amended Invoice appears on the same URL; changed terms require review', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, bookedSummary(), [
		{ status: 409, body: { code: 'conflict', message: 'PAYMENT_TERMS_CHANGED' } }
	]);
	await simulateStripe(page, publicId);
	await open(page, publicId, token);
	await expect(page.getByTestId('document-label')).toHaveText('Invoice');
	const amended = bookedSummary({
		document: {
			...bookedSummary().document,
			version: 7,
			businessRevision: 9,
			totalAmount: '1400.00'
		},
		requiredAmount: '1160.00',
		balance: '1160.00'
	});
	await update(request, publicId, { summary: amended });
	await page.getByRole('button', { name: 'Pay $960.00' }).click();
	await expect(page.getByTestId('payment-notice')).toContainText('Your booking was updated');
	await expect(page.getByTestId('document-label')).toHaveText('Invoice');
	await expect(page.getByRole('button', { name: 'Pay $1,160.00' })).toBeVisible();
	await page.reload(); // same URL, bearer from this tab
	await expect(page.getByTestId('document-label')).toHaveText('Invoice');
	await page.getByRole('button', { name: 'Pay $1,160.00' }).click();
	await expect(page).toHaveURL(/checkout\.stripe\.com/);
	const sent = await posts(request, publicId);
	expect(sent).toHaveLength(2);
	expect(sent[1].key).not.toBe(sent[0].key);
	expect(sent[1].body).toBe('{"expectedDocumentVersion":7,"expectedBusinessRevision":9}');
});

test('without the fragment or this tab’s storage the page asks for the original link', async ({
	page,
	request
}) => {
	const { publicId } = await scenario(request, quotedSummary());
	await open(page, publicId);
	await expect(page.getByTestId('payment-message')).toContainText('Payment link required');
	expect(await calls(request, publicId)).toEqual([]);
	await page.goto(`/pay/${publicId}#not-a-real-secret`);
	await expect(page.getByTestId('payment-message')).toContainText('looks incomplete');
	expect(await page.evaluate(() => location.hash)).toBe('');
	expect(await calls(request, publicId)).toEqual([]);
});

test('a revoked or rotated link stops working and is forgotten', async ({ page, request }) => {
	const { publicId, token } = await scenario(request, quotedSummary());
	await open(page, publicId, token);
	await expect(page.getByTestId('deposit-amount')).toBeVisible();
	await update(request, publicId, { rotate: true });
	await page.reload();
	await expect(page.getByTestId('payment-message')).toContainText('no longer active');
	expect(
		await page.evaluate((id) => sessionStorage.getItem(`fionas.pay.${id}.token`), publicId)
	).toBeNull();
	const { token: rotated } = await update(request, publicId, { revoked: true });
	await open(page, publicId, rotated);
	await expect(page.getByTestId('payment-message')).toContainText('no longer active');
});

test('a payment underway suppresses new collection and polls the summary', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, inProgress(quotedSummary(), false));
	await open(page, publicId, token);
	await expect(page.getByRole('heading', { name: 'A payment is already underway' })).toBeVisible();
	await expect(page.getByTestId('pay')).toHaveCount(0);
	await expect(page.getByTestId('recover-payment')).toHaveCount(0);
	await expect(page.getByTestId('polling-status')).toHaveText('Checking for updates…');
	await update(request, publicId, { summary: bookedSummary() });
	await expect(page.getByRole('button', { name: 'Pay $960.00' })).toBeVisible({ timeout: 15_000 });
	expect(await posts(request, publicId)).toHaveLength(0);
});

test('a new browser recovers an abandoned Checkout with one deliberate check', async ({
	page,
	request
}) => {
	// The original Session expired but its webhook never arrived; this browser has no old key.
	const { publicId, token } = await scenario(request, inProgress(quotedSummary()), [
		{ status: 409, body: { code: 'checkout_in_progress', message: 'x' } },
		{ replace: true }
	]);
	await simulateStripe(page, publicId);
	await open(page, publicId, token);
	await expect(page.getByTestId('pay')).toHaveCount(0);
	const recover = page.getByRole('button', { name: 'Check previous payment and continue' });
	await recover.click();
	await expect(page.getByTestId('payment-notice')).toContainText(
		'An earlier checkout is still open'
	);
	await page.waitForTimeout(1500);
	expect(await posts(request, publicId)).toHaveLength(1); // never an automatic fresh-key loop
	await recover.click();
	await expect(page).toHaveURL(/checkout\.stripe\.com/);
	const sent = await posts(request, publicId);
	expect(sent).toHaveLength(2);
	expect(sent[1].key).not.toBe(sent[0].key);
	expect(sent[1].body).toBe('{"expectedDocumentVersion":3,"expectedBusinessRevision":4}');
});

test('a lost response retries the same key and body, then waits for the customer', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, quotedSummary(), [
		'drop',
		{ status: 500, body: { code: 'internal_failure', message: 'PRIVATE' } },
		'drop'
	]);
	await simulateStripe(page, publicId);
	await open(page, publicId, token);
	await page.getByRole('button', { name: 'Pay deposit $240.00' }).click();
	await expect(page.getByTestId('payment-notice')).toContainText(
		"We couldn't confirm your payment started",
		{ timeout: 20_000 }
	);
	await expect(page.getByTestId('pay')).toHaveCount(0);
	await expect(page.getByText('PRIVATE')).toHaveCount(0);
	let sent = await posts(request, publicId);
	expect(sent).toHaveLength(3);
	expect(new Set(sent.map((c) => c.key)).size).toBe(1);
	expect(new Set(sent.map((c) => c.body)).size).toBe(1);
	await page.getByTestId('retry-payment').click();
	await expect(page).toHaveURL(/checkout\.stripe\.com/);
	sent = await posts(request, publicId);
	expect(sent).toHaveLength(4);
	expect(sent[3].key).toBe(sent[0].key);
});

test('rapid repeated clicks authorize one payment', async ({ page, request }) => {
	const { publicId, token } = await scenario(request, quotedSummary(), [{ delay: 800 }]);
	await page.route('https://checkout.stripe.com/**', (route) =>
		route.fulfill({ contentType: 'text/html', body: '<h1>Stripe</h1>' })
	);
	await open(page, publicId, token);
	const pay = page.getByRole('button', { name: 'Pay deposit $240.00' });
	await expect(pay).toBeEnabled();
	// Three clicks in one task, before the page can re-render or disable anything.
	await pay.evaluate((button: HTMLButtonElement) => {
		button.click();
		button.click();
		button.click();
	});
	await expect(page).toHaveURL(/checkout\.stripe\.com/);
	expect(await posts(request, publicId)).toHaveLength(1);
});

test('a payment needing staff review blocks collection with a contact path', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(
		request,
		quotedSummary({
			canPay: false,
			unavailableReason: 'RECONCILIATION_PENDING',
			reconciliationPending: true
		})
	);
	await open(page, publicId, token);
	await expect(page.getByTestId('reconciliation-message')).toHaveText(
		"We received a payment that needs staff review. Please contact Fiona's before paying again."
	);
	await expect(page.getByTestId('pay')).toHaveCount(0);
	await expect(page.getByTestId('stage-label')).toHaveText('Quote ready');
	await expect(
		page.getByTestId('payment-action').getByRole('link', { name: /contact@/ })
	).toBeVisible();
});

test('a CLOSED booking is read-only payment history', async ({ page, request }) => {
	const { publicId, token } = await scenario(
		request,
		bookedSummary({
			lifecycle: 'CLOSED',
			canPay: false,
			unavailableReason: 'CLOSED',
			requiredAmount: '0.00',
			paidAmount: '1200.00',
			balance: '0.00',
			history: [
				{ amount: '240.00', refundedAmount: '0.00', receivedAt: '2027-03-01T18:00:00Z' },
				{ amount: '960.00', refundedAmount: '50.00', receivedAt: '2027-05-02T18:00:00Z' }
			]
		})
	);
	await open(page, publicId, token);
	await expect(page.getByRole('heading', { name: 'This booking is closed' })).toBeVisible();
	await expect(page.getByTestId('pay')).toHaveCount(0);
	const history = page.getByTestId('payment-history');
	await expect(history.getByRole('listitem')).toHaveCount(2);
	await expect(history).toContainText('Refunded $50.00');
	await expect(history).toContainText('Mar 1, 2027');
});

test('disabled online payments and an unreachable backend fail safely', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, quotedSummary());
	await update(request, publicId, { mode: 'disabled' });
	await open(page, publicId, token);
	await expect(page.getByTestId('payment-message')).toContainText(
		'Please try again later or contact us for help.'
	);
	await expect(page.getByTestId('payment-message')).not.toContainText(/charged/i);
	await update(request, publicId, { mode: 'error' });
	await page.reload();
	await expect(page.getByTestId('payment-message')).toContainText(
		"We can't load your booking right now"
	);
	await expect(page.getByText('PRIVATE')).toHaveCount(0);
	await update(request, publicId, { mode: null });
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByTestId('deposit-amount')).toHaveText('$240.00');
});

const STATUS_UNKNOWN =
	"We can't confirm your payment status right now. Please don't make another payment until we've checked it.";

test('after returning from Stripe, an outage never claims the customer was not charged', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, quotedSummary());
	await simulateStripe(page, publicId);
	await open(page, publicId, token);
	await page.getByRole('button', { name: 'Pay deposit $240.00' }).click();
	await expect(page).toHaveURL(/checkout\.stripe\.com/);
	await update(request, publicId, { mode: 'disabled' });
	await page.getByRole('link', { name: "Back to Fiona's" }).click();
	const message = page.getByTestId('payment-message');
	await expect(message).toContainText(STATUS_UNKNOWN);
	await expect(message).not.toContainText(/haven't been charged|not charged/i);
	await update(request, publicId, { mode: 'error' });
	await page.reload();
	await expect(message).toContainText(STATUS_UNKNOWN);
	await expect(page.getByText(/Deposit received|Payment received/)).toHaveCount(0);
	// Once commerce answers again, the authoritative state decides.
	await update(request, publicId, { mode: null, summary: bookedSummary() });
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByTestId('payment-notice')).toContainText('Deposit received');
});

test('an unknown checkout from an earlier visit keeps the status-unknown wording', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, quotedSummary(), ['drop', 'drop', 'drop']);
	await open(page, publicId, token);
	await page.getByRole('button', { name: 'Pay deposit $240.00' }).click();
	await expect(page.getByTestId('retry-payment')).toBeVisible({ timeout: 20_000 });
	await update(request, publicId, { mode: 'error' });
	await page.reload();
	await expect(page.getByTestId('payment-message')).toContainText(STATUS_UNKNOWN);
	await update(request, publicId, { mode: 'disabled' });
	await page.reload();
	await expect(page.getByTestId('payment-message')).toContainText(STATUS_UNKNOWN);
});

test('a summary that could not be refreshed cannot start a new payment', async ({
	page,
	request
}) => {
	await page.clock.install();
	const { publicId, token } = await scenario(request, quotedSummary());
	await open(page, publicId, token);
	const pay = page.getByRole('button', { name: 'Pay deposit $240.00' });
	await expect(pay).toBeEnabled();
	// Five minutes later the page re-reads before paying; that read fails.
	await update(request, publicId, { mode: 'error' });
	await page.clock.fastForward('06:00');
	await pay.click();
	await expect(page.getByTestId('stale-summary')).toContainText('paying is paused');
	await expect(page.getByTestId('payment-notice')).toContainText(
		"We couldn't refresh your booking"
	);
	await expect(pay).toBeDisabled();
	await expect(page.getByTestId('deposit-amount')).toHaveText('$240.00'); // still shown
	expect(await posts(request, publicId)).toHaveLength(0);
	// Staff publish new terms meanwhile; a successful check shows them before any payment.
	await update(request, publicId, {
		mode: null,
		summary: quotedSummary({
			requiredAmount: '300.00',
			document: { ...quotedSummary().document, version: 4, businessRevision: 5 }
		})
	});
	await page.getByTestId('stale-summary').getByRole('button', { name: 'Check again' }).click();
	await expect(page.getByRole('button', { name: 'Pay deposit $300.00' })).toBeEnabled();
	await expect(page.getByTestId('document-label')).toHaveText('Quote');
	expect(await posts(request, publicId)).toHaveLength(0);
});

test('unknown states and codes never enable payment', async ({ page, request }) => {
	const { publicId, token } = await scenario(
		request,
		quotedSummary({ canPay: false, unavailableReason: 'SOMETHING_NEW' }),
		[{ status: 409, body: { code: 'brand_new_code', message: 'x' } }]
	);
	await open(page, publicId, token);
	await expect(page.getByText("Online payment isn't available for this booking")).toBeVisible();
	await expect(page.getByTestId('pay')).toHaveCount(0);
});

test('the BFF refuses cross-origin and malformed calls before commerce', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, quotedSummary());
	await open(page, publicId, token);
	const base = test.info().project.use.baseURL;
	const body = '{"expectedDocumentVersion":3,"expectedBusinessRevision":4}';
	const headers = {
		'content-type': 'application/json',
		'idempotency-key': 'k1',
		'x-fionas-payment-token': token
	};
	const crossOrigin = await request.post(`${base}/api/payments/${publicId}/checkout-sessions`, {
		headers: { ...headers, origin: 'https://evil.example' },
		data: body
	});
	expect(crossOrigin.status()).toBe(403);
	expect(crossOrigin.headers()['cache-control']).toBe('no-store');
	const injected = await request.post(`${base}/api/payments/${publicId}/checkout-sessions`, {
		headers: { ...headers, origin: base! },
		data: '{"expectedDocumentVersion":3,"expectedBusinessRevision":4,"currency":"EUR"}'
	});
	expect(injected.status()).toBe(400);
	const crossSite = await request.get(`${base}/api/payments/${publicId}`, {
		headers: { 'x-fionas-payment-token': token, 'sec-fetch-site': 'cross-site' }
	});
	expect(crossSite.status()).toBe(403);
	const invalid = await request.get(`${base}/api/payments/${publicId}`, {
		headers: { 'x-fionas-payment-token': 'Z'.repeat(43) }
	});
	expect(invalid.status()).toBe(404);
	expect(await invalid.json()).toEqual({ code: 'not_found' });
	expect(await posts(request, publicId)).toHaveLength(0);
});

test('keyboard-only payment, no horizontal scroll and readable layout', async ({
	page,
	request
}) => {
	const { publicId, token } = await scenario(request, bookedSummary());
	await simulateStripe(page, publicId);
	await open(page, publicId, token);
	await expect(page.getByTestId('pay')).toBeVisible();
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(0);
	const box = await page.getByTestId('pay').boundingBox();
	expect(box!.height).toBeGreaterThanOrEqual(44);
	await page.getByRole('radio', { name: /Remaining balance/ }).focus();
	await page.keyboard.press('ArrowDown');
	await expect(page.getByRole('radio', { name: 'A different amount' })).toBeChecked();
	await page.keyboard.press('Tab');
	await expect(page.getByLabel('Amount (USD)')).toBeFocused();
	await page.keyboard.type('250.50');
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL(/checkout\.stripe\.com/);
	expect((await posts(request, publicId))[0].body).toContain('"amountMinor":25050');
});

test.describe('without JavaScript', () => {
	test.use({ javaScriptEnabled: false });
	test('a branded fallback explains why JavaScript is needed', async ({ page, request }) => {
		const { publicId, token } = await scenario(request, quotedSummary());
		await open(page, publicId, token);
		await expect(page.getByTestId('no-js')).toContainText('Please turn on JavaScript to continue');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('your booking');
		expect(await calls(request, publicId)).toEqual([]);
	});
});
