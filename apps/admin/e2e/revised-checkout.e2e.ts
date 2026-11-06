import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { route, session, signIn, stubUrl } from './request-helpers.js';
import { mayaId } from './request-fixture.mjs';
import { revisionFixture } from './revision-fixture.mjs';
import { paymentAttemptFixture } from './payment-access-stub.mjs';

/*
 * fionas-commerce PR #41: staff can email a revised Quote while the customer's earlier Stripe
 * Checkout is still open, and release that checkout separately through the existing reconcile
 * command. Payment collection may be blocked; customer communication never is.
 */
const PERMISSIONS = [
	'fionas.inquiries.read',
	'commerce.financial-document.read',
	'fionas.communications.read',
	'fionas.communications.send',
	'fionas.payment-access.manage'
];

async function stub(context: BrowserContext, path: string, update?: unknown) {
	const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
	const response =
		update === undefined
			? await context.request.get(`${stubUrl}${path}`, { headers: { cookie } })
			: await context.request.post(`${stubUrl}${path}`, { headers: { cookie }, data: update });
	expect(response.ok()).toBe(true);
	return update === undefined ? response.json() : null;
}
const payments = (context: BrowserContext, update?: unknown) =>
	stub(context, '/__test/payments', update);
const conversation = (context: BrowserContext, update: unknown) =>
	stub(context, '/__test/conversation', update);
const emails = (context: BrowserContext) => stub(context, '/__test/financial-email');

/** Quote v2's deposit checkout: $300, ledger version 2, business revision 2. */
const quoteV2Checkout = () =>
	paymentAttemptFixture({
		purpose: 'DEPOSIT',
		authorizedMinor: 30000,
		documentVersion: 2,
		businessRevision: 2,
		createdAt: '2026-11-05T18:00:00Z',
		expiresAt: '2026-11-06T18:00:00Z'
	});

/**
 * Maya QUOTED at Quote v2 (or v3 after a repriced line) with an active link and the given
 * attempts. The revised Quote stands in for staff's own Revise quote PRG.
 */
async function setup(
	page: Page,
	context: BrowserContext,
	{ revised = true, attempts = [quoteV2Checkout()], live = false } = {}
) {
	await signIn(page);
	const current = await session(context);
	const request = revisionFixture(revised ? 'quote-financial-revision' : 'quoted');
	await session(context, {
		request,
		permissions: [...new Set([...current.permissions, ...PERMISSIONS])]
	});
	await conversation(context, { reset: true, ...(live && { updates: 'live' }) });
	await stub(context, '/__test/financial-email', { mode: 'accepted' });
	await payments(context, {
		inquiryId: mayaId,
		access: {},
		attempts,
		reconcile: null,
		mode: null,
		attemptsUnavailable: false
	});
	return { request, attempts };
}
/** What commerce now lists for the attempts: the same ids, new provider state. */
const listAttempts = (context: BrowserContext, attempts: unknown[]) =>
	payments(context, { inquiryId: mayaId, attempts });
/** One live timeline notification (SSE), as commerce sends after a change. */
const notify = (context: BrowserContext) => conversation(context, { notify: true });
const attemptReads = async (context: BrowserContext) =>
	(await payments(context)).calls.filter(
		(c: { method: string; path: string }) =>
			c.method === 'GET' && c.path.endsWith('/payment-attempts')
	).length;
const card = (page: Page) => page.getByTestId('customer-payments');
const previous = (page: Page) => card(page).getByTestId('previous-checkout');
const release = (page: Page) => card(page).getByTestId('release-previous-checkout');
const panel = (page: Page) => page.getByTestId('financial-email-panel');
const reconcileCalls = async (context: BrowserContext) =>
	(await payments(context)).calls.filter(
		(c: { method: string; path: string }) => c.method === 'POST' && c.path.endsWith('/reconcile')
	);

async function preview(page: Page) {
	await page.getByTestId('open-financial-email').click();
	await expect(panel(page)).toBeVisible();
	await page.getByRole('button', { name: 'Preview email', exact: true }).click();
	await expect(panel(page).getByTestId('financial-email-review')).toBeVisible();
}

test('a matching open checkout keeps Check payment status and offers no release', async ({
	page,
	context
}) => {
	await setup(page, context, { revised: false });
	await page.goto(route);
	await expect(card(page).getByTestId('payment-link-status')).toHaveText('Link active');
	await expect(previous(page)).toHaveCount(0);
	await expect(card(page).getByTestId('checkout-status')).toHaveCount(0);
	await card(page)
		.getByText(/Online payment attempts \(1\)/)
		.click();
	const row = card(page).getByTestId('payment-attempt');
	await expect(row.getByTestId('payment-attempt-terms')).toHaveText('Matches the current terms.');
	await row.getByText('Check with Stripe…').click();
	await expect(row.getByTestId('reconcile-attempt')).toHaveText('Check payment status');
	await row.getByTestId('reconcile-attempt').click();
	// The stub leaves a current checkout open, like commerce: nothing claims a release.
	await expect(card(page).getByTestId('customer-payments-status')).toContainText(
		'still open, so it wasn’t released'
	);
	await expect(page.getByTestId('open-financial-email')).toHaveText('Email quote');
});

test('Quote v3: email it while Quote v2’s checkout is open, then release that checkout', async ({
	page,
	context
}) => {
	const { request, attempts } = await setup(page, context);
	await page.goto(route);
	// 1. The current Quote is ready to be emailed.
	await expect(page.getByTestId('financial-email-summary')).toHaveText(
		'This Quote hasn’t been emailed. Publishing it didn’t send anything.'
	);
	await expect(page.getByTestId('open-financial-email')).toHaveText('Email quote');
	// 2. The earlier checkout is visible without opening the diagnostics.
	await expect(card(page).getByTestId('payment-attempts')).not.toHaveAttribute('open', '');
	await expect(previous(page)).toBeVisible();
	await expect(previous(page)).toContainText('Previous checkout is still open');
	await expect(previous(page)).toContainText(
		'The customer started a deposit of $300.00 using an earlier version of this booking.'
	);
	await expect(previous(page)).toContainText(
		'It was started for Quote v2; the current terms are Quote v3.'
	);
	await expect(release(page)).toHaveText('Release previous checkout');

	// Email first: no release is required, and the checkout stays open throughout.
	await preview(page);
	await expect(panel(page).getByTestId('email-document')).toHaveText('Quote v3');
	const frame = page.frameLocator('[data-testid="email-preview-frame"]');
	const line = request.financial.lines[0];
	await expect(frame.locator('[data-line]').first()).toContainText(line.description);
	await expect(frame.locator('[data-line]').first()).toContainText(`$${line.total}`);
	await expect(frame.locator('#pay')).toHaveText('Review your updated quote');
	await page.getByRole('button', { name: 'Send quote', exact: true }).click();
	await expect(page.getByTestId('financial-email-accepted')).toBeVisible();
	const sent = await emails(context);
	expect(sent.sends).toHaveLength(1);
	expect(sent.sends[0].body.email).toMatchObject({
		kind: 'QUOTE',
		expectedDocumentVersion: request.financial.version,
		expectedBusinessRevision: 3,
		proposalId: request.proposal!.id
	});
	expect(await reconcileCalls(context)).toHaveLength(0);
	await expect(previous(page)).toBeVisible();

	// Then release: one deliberate click, one reconcile of exactly that attempt.
	await payments(context, { reconcile: { result: { state: 'EXPIRED' } } });
	await release(page).click();
	await expect(card(page).getByTestId('customer-payments-status')).toContainText(
		'Stripe confirmed the previous checkout expired, so it’s released.'
	);
	await expect(card(page).getByTestId('customer-payments-status')).toContainText(
		'if the current terms allow it'
	);
	await expect(previous(page)).toHaveCount(0);
	await card(page)
		.getByText(/Online payment attempts \(1\)/)
		.click();
	await expect(card(page).getByTestId('payment-attempt')).toContainText('Expired');
	const calls = await reconcileCalls(context);
	expect(calls).toHaveLength(1);
	expect(calls[0].path).toBe(
		`/staff/requests/${mayaId}/payment-attempts/${attempts[0].id}/reconcile`
	);
	expect(await page.content()).not.toContain('cs_test_private');
});

test('releasing a checkout keeps an open email preview reviewable; a new Quote still invalidates it', async ({
	page,
	context
}) => {
	await setup(page, context, { live: true });
	await page.goto(route);
	await expect(page.getByTestId('live-status')).toHaveText('Live');
	await preview(page);
	await page.getByLabel('Message', { exact: true }).fill('Unsent reply draft');
	const send = page.getByRole('button', { name: 'Send quote', exact: true });
	await expect(send).toBeEnabled();

	await payments(context, { reconcile: { result: { state: 'EXPIRED' } } });
	await release(page).click();
	await expect(card(page).getByTestId('customer-payments-status')).toContainText('released');
	// A live update afterwards changes nothing the review binds.
	await conversation(context, { notify: true });
	await expect(page.getByTestId('live-status')).toHaveText('Live');
	await expect(send).toBeEnabled();
	await expect(panel(page)).not.toContainText('changed since this preview');
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Unsent reply draft');

	// A real document change still does: commerce refuses the stale review.
	const v4 = revisionFixture('quote-financial-revision');
	v4.currentQuoteRevision = 4;
	v4.proposal!.quoteRevision = 4;
	await session(context, { request: v4 });
	await send.click();
	await expect(page.getByTestId('financial-email-error')).toContainText(
		'changed since this preview'
	);
	expect((await emails(context)).dispatched ?? 0).toBe(0);
});

test('a refused or unconfirmed release never claims the checkout was released', async ({
	page,
	context
}) => {
	await setup(page, context);
	await page.goto(route);
	// Stripe couldn't be reached: possibly committed, so the card blocks until a reload.
	await payments(context, { reconcile: { status: 502, code: 'stripe_unavailable' } });
	await release(page).click();
	const error = card(page).getByTestId('customer-payments-error');
	await expect(error).toContainText("Don't assume the checkout was released or paid");
	await expect(error.getByRole('link', { name: 'Reload to review' })).toBeVisible();
	await expect(release(page)).toBeDisabled();
	await expect(card(page)).not.toContainText('it’s released');
	expect(await reconcileCalls(context)).toHaveLength(1);
	// Email stays independent of the blocked card.
	await expect(page.getByTestId('open-financial-email')).toBeEnabled();

	// Stripe answers that the session is still open: nothing is released, the offer remains.
	await payments(context, { reconcile: { result: { state: 'OPEN' } } });
	await page.reload();
	await release(page).click();
	await expect(card(page).getByTestId('customer-payments-status')).toContainText(
		'still open, so it wasn’t released'
	);
	await expect(previous(page)).toBeVisible();

	// A conflict proves only that no confirmed outcome came back: reload before anything else.
	await payments(context, {
		reconcile: { status: 409, code: 'CHECKOUT_CREATION_UNKNOWN_REQUIRES_RECONCILIATION' }
	});
	await release(page).click();
	const conflict = card(page).getByTestId('customer-payments-error');
	await expect(conflict).toContainText(
		"We couldn't reconcile this checkout, and no release was confirmed."
	);
	await expect(conflict).not.toContainText(/nothing was|settled|cancel/i);
	await expect(conflict.getByRole('link', { name: 'Reload to review' })).toBeVisible();
	await expect(release(page)).toBeDisabled();
	await expect(card(page)).not.toContainText('CHECKOUT_CREATION');
	await expect(card(page)).not.toContainText('it’s released');
	// Never retried, and the email workflow stays available.
	await page.waitForTimeout(300);
	expect(await reconcileCalls(context)).toHaveLength(3);
	await expect(page.getByTestId('open-financial-email')).toBeEnabled();
});

test('a release that finds a payment in flight or captured reports that, never a release', async ({
	page,
	context
}) => {
	await setup(page, context);
	await page.goto(route);
	await payments(context, { reconcile: { result: { state: 'PROCESSING' } } });
	await release(page).click();
	const status = card(page).getByTestId('customer-payments-status');
	await expect(status).toContainText('Don’t start or record another payment');
	await expect(status).toHaveAttribute('data-tone', 'warning');
	await expect(card(page)).not.toContainText('it’s released');
	await expect(previous(page)).toHaveCount(0);
	const confirming = card(page).getByTestId('checkout-status');
	await expect(confirming).toContainText('A payment is being confirmed');
	await expect(confirming.getByTestId('check-payment-status')).toHaveText('Check payment status');

	// Captured against obsolete terms: unapplied money for staff reconciliation, never another charge.
	await payments(context, {
		reconcile: {
			result: {
				state: 'SUCCEEDED',
				outcome: 'RECONCILIATION_REQUIRED',
				ledgerPaymentId: '40000000-0000-0000-0000-000000000099'
			}
		}
	});
	await confirming.getByTestId('check-payment-status').click();
	await expect(status).toContainText('needs staff reconciliation');
	await expect(status).not.toContainText(/refund|cancel|lost/i);
	await expect(card(page).getByTestId('reconciliation-warning')).toBeVisible();
	await expect(card(page).getByTestId('checkout-status')).toHaveCount(0);
	await expect(card(page).getByTestId('release-previous-checkout')).toHaveCount(0);
});

test('a payment applied during the check refreshes Right now in place', async ({
	page,
	context
}) => {
	await setup(page, context);
	await page.goto(route);
	await page.getByLabel('Message', { exact: true }).fill('Draft that must survive');
	await expect(page.getByTestId('deposit-summary')).toBeVisible();
	// Commerce applied the payment: the booking moves on, and its projection says so.
	await payments(context, {
		reconcile: {
			result: {
				state: 'SUCCEEDED',
				outcome: 'APPLIED',
				ledgerPaymentId: '40000000-0000-0000-0000-000000000098'
			},
			request: revisionFixture('booked')
		}
	});
	await release(page).click();
	await expect(card(page).getByTestId('customer-payments-status')).toContainText(
		'it’s applied to this booking'
	);
	await expect(page.getByTestId('request-balance')).toBeVisible();
	await expect(page.getByTestId('deposit-summary')).toHaveCount(0);
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Draft that must survive');
});

test('unconfirmed and in-flight checkouts offer a status check, never a release', async ({
	page,
	context
}) => {
	await setup(page, context, {
		attempts: [
			paymentAttemptFixture({
				purpose: 'DEPOSIT',
				state: 'CREATING',
				createdAt: '2026-11-05T19:00:00Z'
			}),
			paymentAttemptFixture({
				purpose: 'DEPOSIT',
				state: 'PROCESSING',
				createdAt: '2026-11-05T20:00:00Z'
			})
		]
	});
	await page.goto(route);
	await expect(release(page)).toHaveCount(0);
	const items = card(page).getByTestId('checkout-status');
	await expect(items).toHaveCount(2);
	await expect(items.nth(0)).toHaveAttribute('data-status', 'processing');
	await expect(items.nth(1)).toHaveAttribute('data-status', 'creating');
	await expect(items.nth(1)).toContainText('Checkout status isn’t confirmed');
	await expect(items.nth(1)).toContainText('Checking never creates a second charge');
	// Email stays available whatever the checkout state.
	await expect(page.getByTestId('open-financial-email')).toHaveText('Email quote');
	await payments(context, { reconcile: { result: { state: 'CREATING' } } });
	await items.nth(1).getByTestId('check-payment-status').click();
	await expect(card(page).getByTestId('customer-payments-status')).toContainText(
		'hasn’t confirmed this checkout yet'
	);
});

test('keyboard: Release previous checkout is reachable and announces its result', async ({
	page,
	context
}) => {
	await setup(page, context);
	await page.goto(route);
	// The notice and its full-width button fit the viewport at phone widths, without page scroll.
	const viewport = page.viewportSize()!;
	for (const target of [previous(page), release(page)]) {
		const box = (await target.boundingBox())!;
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
	}
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
		viewport.width
	);
	expect((await release(page).boundingBox())!.height).toBeGreaterThanOrEqual(44);
	await payments(context, { reconcile: { result: { state: 'EXPIRED' } } });
	await release(page).focus();
	await expect(release(page)).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(card(page).getByRole('status')).toContainText('released');
	expect(await reconcileCalls(context)).toHaveLength(1);
});

test.describe('live updates keep the checkout notices accurate with diagnostics closed', () => {
	test('an expiry removes the Release notice; the email preview and reply draft stay', async ({
		page,
		context
	}) => {
		const { attempts } = await setup(page, context, { live: true });
		await page.goto(route);
		await expect(page.getByTestId('live-status')).toHaveText('Live');
		await preview(page);
		await expect(page.getByTestId('live-status')).toHaveText('Live');
		await page.getByLabel('Message', { exact: true }).fill('Unsent reply draft');
		await expect(release(page)).toBeVisible();
		await expect(card(page).getByTestId('payment-attempts')).not.toHaveAttribute('open', '');

		// Stripe expired it on its own (or another staff member released it).
		await listAttempts(context, [{ ...attempts[0], state: 'EXPIRED' }]);
		await notify(context);
		await expect(previous(page)).toHaveCount(0);
		await expect(card(page).getByTestId('payment-attempts')).not.toHaveAttribute('open', '');
		// A refresh reports nothing on its own: only a deliberate check words an outcome.
		await expect(card(page).getByTestId('customer-payments-status')).toHaveText('');
		await expect(page.getByRole('button', { name: 'Send quote', exact: true })).toBeEnabled();
		await expect(panel(page)).not.toContainText('changed since this preview');
		await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Unsent reply draft');
		expect(await reconcileCalls(context)).toHaveLength(0);
	});

	test('OPEN → PROCESSING → SUCCEEDED/APPLIED replaces the notice, never claiming a release', async ({
		page,
		context
	}) => {
		const { attempts } = await setup(page, context, { live: true });
		await page.goto(route);
		await expect(page.getByTestId('live-status')).toHaveText('Live');
		await expect(release(page)).toBeVisible();

		await listAttempts(context, [{ ...attempts[0], state: 'PROCESSING' }]);
		await notify(context);
		const confirming = card(page).getByTestId('checkout-status');
		await expect(confirming).toHaveAttribute('data-status', 'processing');
		await expect(confirming).toContainText('A payment is being confirmed');
		await expect(release(page)).toHaveCount(0);

		await listAttempts(context, [
			{
				...attempts[0],
				state: 'SUCCEEDED',
				outcome: 'APPLIED',
				ledgerPaymentId: '40000000-0000-0000-0000-000000000097'
			}
		]);
		await notify(context);
		await expect(confirming).toHaveCount(0);
		await expect(previous(page)).toHaveCount(0);
		await expect(card(page)).not.toContainText(/cancel|released/i);
		await card(page)
			.getByText(/Online payment attempts \(1\)/)
			.click();
		await expect(card(page).getByTestId('payment-attempt')).toContainText('Paid at Stripe');
		await expect(card(page).getByTestId('payment-attempt')).toContainText('Applied to the booking');
	});

	test('rapid notifications settle on the newest state', async ({ page, context }) => {
		const { attempts } = await setup(page, context, { live: true });
		await page.goto(route);
		await expect(page.getByTestId('live-status')).toHaveText('Live');
		await expect(release(page)).toBeVisible();
		const before = await attemptReads(context);
		await listAttempts(context, [{ ...attempts[0], state: 'PROCESSING' }]);
		await notify(context);
		await listAttempts(context, [{ ...attempts[0], state: 'EXPIRED' }]);
		await notify(context);
		await notify(context);
		await expect(card(page).getByTestId('checkout-status')).toHaveCount(0);
		await expect(previous(page)).toHaveCount(0);
		// Still the newest state once every read has drained.
		await page.waitForTimeout(500);
		await expect(card(page).getByTestId('checkout-status')).toHaveCount(0);
		await expect(previous(page)).toHaveCount(0);
		// Reads are serialized and coalesced, never one per notification and never a polling loop.
		const reads = (await attemptReads(context)) - before;
		expect(reads).toBeGreaterThanOrEqual(1);
		expect(reads).toBeLessThanOrEqual(4);
		await page.waitForTimeout(500);
		expect((await attemptReads(context)) - before).toBe(reads);
	});

	test('a failed refresh keeps the last known state, unconfirmed, until a read succeeds', async ({
		page,
		context
	}) => {
		const { attempts } = await setup(page, context, { live: true });
		await page.goto(route);
		await expect(page.getByTestId('live-status')).toHaveText('Live');
		await expect(release(page)).toBeVisible();

		await payments(context, { attemptsUnavailable: true });
		await listAttempts(context, [{ ...attempts[0], state: 'EXPIRED' }]);
		await notify(context);
		const stale = card(page).getByTestId('checkout-status-stale');
		await expect(stale).toContainText('We couldn’t refresh the checkout status');
		await expect(stale.getByRole('link', { name: 'Reload to review' })).toBeVisible();
		// Last known, not confirmed: no conclusive "still open" and no release offer.
		await expect(previous(page)).toHaveAttribute('data-confirmed', 'false');
		await expect(previous(page)).toContainText('Previous checkout may still be open');
		await expect(release(page)).toHaveCount(0);
		await expect(previous(page).getByTestId('check-payment-status')).toBeVisible();
		await expect(card(page)).not.toContainText(/released|expired/i);

		await payments(context, { attemptsUnavailable: false });
		await notify(context);
		await expect(stale).toHaveCount(0);
		await expect(previous(page)).toHaveCount(0);
	});

	test('an unsupported state/outcome pair is investigated, never shown as paid or released', async ({
		page,
		context
	}) => {
		await setup(page, context, {
			attempts: [
				{
					...quoteV2Checkout(),
					state: 'OPEN',
					outcome: 'APPLIED',
					ledgerPaymentId: '40000000-0000-0000-0000-000000000096'
				}
			]
		});
		await page.goto(route);
		const notice = card(page).getByTestId('checkout-status');
		await expect(notice).toHaveAttribute('data-status', 'unrecognized');
		await expect(notice).toContainText('Checkout status needs investigation');
		await expect(notice).toContainText('isn’t shown as paid, applied or released');
		await expect(notice.getByTestId('reload-checkout-status')).toBeVisible();
		await expect(notice.getByTestId('check-payment-status')).toHaveCount(0);
		await expect(release(page)).toHaveCount(0);
		await expect(card(page).getByTestId('reconciliation-warning')).toHaveCount(0);
		await card(page)
			.getByText(/Online payment attempts \(1\)/)
			.click();
		const row = card(page).getByTestId('payment-attempt');
		await expect(row).toContainText('Status unclear');
		await expect(row).toContainText('Outcome not confirmed');
		await expect(row).not.toContainText('Applied to the booking');
		await expect(row.getByTestId('reconcile-attempt')).toHaveCount(0);
	});
});

test.describe('without JavaScript', () => {
	test.use({ javaScriptEnabled: false });

	test('Release previous checkout posts natively and re-renders the provider result', async ({
		page,
		context
	}) => {
		await setup(page, context);
		await page.goto(route);
		await payments(context, { reconcile: { result: { state: 'EXPIRED' } } });
		await release(page).click();
		await expect(card(page).getByTestId('customer-payments-status')).toContainText('released');
		await expect(previous(page)).toHaveCount(0);
		expect(await reconcileCalls(context)).toHaveLength(1);
		// Emailing the current Quote still opens natively.
		await expect(page.getByTestId('open-financial-email')).toHaveText('Email quote');
	});
});
