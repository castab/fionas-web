import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { route, session, signIn, stubUrl } from './request-helpers.js';
import { mayaId, paymentFixture, requestFixtures } from './request-fixture.mjs';
import { paymentAttemptFixture } from './payment-access-stub.mjs';

const PAYMENT_ACCESS = [
	'fionas.payment-access.manage',
	'fionas.inquiries.read',
	'commerce.financial-document.read'
];
const closedId = '00000000-0000-0000-0000-000000000002';

async function payments(context: BrowserContext, update?: unknown) {
	const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
	const response =
		update === undefined
			? await context.request.get(`${stubUrl}/__test/payments`, { headers: { cookie } })
			: await context.request.post(`${stubUrl}/__test/payments`, {
					headers: { cookie },
					data: update
				});
	expect(response.ok()).toBe(true);
	return update === undefined ? response.json() : null;
}

async function conversation(context: BrowserContext, update: unknown) {
	const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
	const response = await context.request.post(`${stubUrl}/__test/conversation`, {
		headers: { cookie },
		data: update
	});
	expect(response.ok()).toBe(true);
}

/** Signs in with the default permissions plus explicit payment access, on a BOOKED Maya. */
async function bookedWithAccess(page: Page, context: BrowserContext, grant = true) {
	await signIn(page);
	const current = await session(context);
	await session(context, {
		request: paymentFixture('booked'),
		permissions: grant
			? [...new Set([...current.permissions, ...PAYMENT_ACCESS])]
			: current.permissions
	});
}

const card = (page: Page) => page.getByTestId('customer-payments');

test('a missing payment-access grant hides the section and keeps every other capability', async ({
	page,
	context
}) => {
	await bookedWithAccess(page, context, false);
	await page.goto(route);
	await expect(page.getByTestId('request-summary')).toBeVisible();
	await expect(page.getByTestId('open-payment')).toHaveText('Record payment');
	await expect(page.getByTestId('amend-invoice')).toBeVisible();
	await expect(page.getByTestId('conversation')).toBeVisible();
	await expect(card(page)).toHaveCount(0);
	expect((await payments(context)).calls).toEqual([]);
});

test('REQUESTED and DECLINED requests never offer a payment link', async ({ page, context }) => {
	await signIn(page);
	const current = await session(context);
	await session(context, { permissions: [...current.permissions, ...PAYMENT_ACCESS] });
	await page.goto(route); // Maya is REQUESTED
	await expect(page.getByTestId('request-summary')).toBeVisible();
	await expect(card(page)).toHaveCount(0);
	await page.goto(`/requests/00000000-0000-0000-0000-000000000008`); // Hannah is DECLINED
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hannah Kim');
	await expect(card(page)).toHaveCount(0);
	expect((await payments(context)).calls).toEqual([]);
});

test('create, copy (stable), rotate and revoke update in place without a workspace reload', async ({
	page,
	context
}) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await bookedWithAccess(page, context);
	await conversation(context, {});
	await page.goto(route);
	await expect(card(page).getByTestId('payment-link-status')).toHaveText('No link');
	// Unsent work elsewhere in the workspace survives every link operation.
	const composer = page.getByLabel('Message', { exact: true });
	await composer.fill('Unsent reply draft');
	await page.evaluate(() => ((window as unknown as { marker: string }).marker = 'same page'));

	await card(page).getByTestId('create-payment-link').click();
	await expect(card(page).getByTestId('payment-link-status')).toHaveText('Link active');
	await expect(card(page).getByTestId('customer-payments-status')).toContainText(
		'Payment link ready'
	);

	await card(page).getByTestId('copy-payment-link').click();
	await expect(card(page).getByTestId('customer-payments-status')).toHaveText(
		'Payment link copied. Paste it into your message to the customer.'
	);
	const first = await page.evaluate(() => navigator.clipboard.readText());
	expect(first).toMatch(/^https:\/\/www\.fionasicecream\.example\/pay\/[0-9a-f-]{36}#[\w-]{43}$/);
	// The usable URL is never left in the page.
	expect(await page.content()).not.toContain(first.split('#')[1]);
	await page.evaluate(() => navigator.clipboard.writeText(''));
	await card(page).getByTestId('copy-payment-link').click();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(first);

	await card(page).getByText('Manage link', { exact: true }).click();
	await card(page).getByText('Rotate link…', { exact: true }).click();
	await expect(card(page)).toContainText('Every copy of the current link stops working');
	await card(page).getByTestId('rotate-payment-link').click();
	await expect(card(page).getByTestId('customer-payments-status')).toContainText(
		'The previous link no longer works'
	);
	await card(page).getByTestId('copy-payment-link').click();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe(first);
	const rotated = await page.evaluate(() => navigator.clipboard.readText());
	expect(rotated.split('#')[0]).toBe(first.split('#')[0]); // same stable publicId path

	await card(page).getByText('Revoke link…', { exact: true }).click();
	await expect(card(page)).toContainText('Payments already underway can still be reconciled');
	await card(page).getByTestId('revoke-payment-link').click();
	await expect(card(page).getByTestId('payment-link-status')).toHaveText('Link revoked');
	await expect(card(page).getByTestId('copy-payment-link')).toHaveCount(0);
	await expect(card(page).getByTestId('create-payment-link')).toHaveText(
		'Issue a new payment link'
	);

	await expect(composer).toHaveValue('Unsent reply draft');
	expect(await page.evaluate(() => (window as unknown as { marker: string }).marker)).toBe(
		'same page'
	);
	const { calls } = await payments(context);
	const mutations = calls.filter((c: { method: string }) => c.method === 'POST');
	expect(mutations.map((c: { path: string }) => c.path.split('/').slice(4).join('/'))).toEqual([
		'payment-access',
		'payment-access/rotate',
		'payment-access/revoke'
	]);
	// Every mutation carried the admin's trusted Origin; copying only ever read.
	expect(new Set(mutations.map((c: { origin: string }) => c.origin))).toEqual(
		new Set([new URL(page.url()).origin])
	);
});

test('the initial workspace HTML carries link status, never the bearer URL', async ({
	page,
	context
}) => {
	await bookedWithAccess(page, context);
	await payments(context, { inquiryId: mayaId, access: {} });
	const response = await page.goto(route);
	const html = await response!.text();
	await expect(card(page).getByTestId('payment-link-status')).toHaveText('Link active');
	expect(html).not.toMatch(/\/pay\/[0-9a-f-]{36}#/);
	expect(html).not.toContain('fionasicecream.example/pay');
});

test('a controlled fallback shows the link when the clipboard is unavailable', async ({
	page,
	context
}) => {
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
	});
	await bookedWithAccess(page, context);
	await payments(context, { inquiryId: mayaId, access: {} });
	await page.goto(route);
	await card(page).getByTestId('copy-payment-link').click();
	const fallback = card(page).getByTestId('payment-link-fallback');
	await expect(fallback.getByRole('textbox')).toHaveValue(/\/pay\/[0-9a-f-]{36}#[\w-]{43}$/);
	await fallback.getByRole('button', { name: 'Hide link' }).click();
	await expect(fallback).toHaveCount(0);
});

test('CLOSED requests can copy and revoke an existing link but never issue or rotate', async ({
	page,
	context
}) => {
	await signIn(page);
	const current = await session(context);
	await session(context, { permissions: [...current.permissions, ...PAYMENT_ACCESS] });
	const closed = `/requests/${closedId}`;
	await page.goto(closed);
	await expect(card(page).getByTestId('payment-link-status')).toHaveText('No link');
	await expect(card(page)).toContainText('a new payment link cannot be created');
	await expect(card(page).getByTestId('create-payment-link')).toHaveCount(0);
	await payments(context, { inquiryId: closedId, access: {} });
	await page.reload();
	await expect(card(page).getByTestId('copy-payment-link')).toBeVisible();
	await card(page).getByText('Manage link', { exact: true }).click();
	await expect(card(page).getByText('Rotate link…')).toHaveCount(0);
	await card(page).getByText('Revoke link…', { exact: true }).click();
	await card(page).getByTestId('revoke-payment-link').click();
	await expect(card(page).getByTestId('payment-link-status')).toHaveText('Link revoked');
	await expect(card(page).getByTestId('create-payment-link')).toHaveCount(0);
	expect(requestFixtures()[closedId].inquiry.lifecycle.stage).toBe('CLOSED');
});

test('attempt diagnostics distinguish reconciliation and offer a safe Stripe check', async ({
	page,
	context
}) => {
	await bookedWithAccess(page, context);
	const open = paymentAttemptFixture({ state: 'OPEN' });
	const stuck = paymentAttemptFixture({
		purpose: 'DEPOSIT',
		authorizedMinor: 30000,
		state: 'SUCCEEDED',
		outcome: 'RECONCILIATION_REQUIRED',
		ledgerPaymentId: '40000000-0000-0000-0000-000000000099',
		diagnostic: 'deposit_terms_changed'
	});
	await payments(context, { inquiryId: mayaId, access: {}, attempts: [open, stuck] });
	await page.goto(route);
	await expect(card(page).getByTestId('reconciliation-warning')).toBeVisible();
	await card(page)
		.getByText(/Online payment attempts \(2\)/)
		.click();
	const rows = card(page).getByTestId('payment-attempt');
	await expect(rows).toHaveCount(2);
	const reconciliation = rows.filter({ hasText: 'Needs staff reconciliation' });
	await expect(reconciliation).toHaveAttribute('data-outcome', 'RECONCILIATION_REQUIRED');
	await expect(reconciliation).toContainText('Ledger payment recorded');
	await expect(reconciliation).toContainText('deposit_terms_changed');
	await expect(reconciliation.getByTestId('reconcile-attempt')).toHaveCount(0);
	const openRow = rows.filter({ hasText: 'Checkout open' });
	await expect(openRow).toContainText('Invoice payment · $100.00');
	await expect(openRow).toContainText('No ledger payment');
	await payments(context, { mode: 'reconcile-expire' });
	await openRow.getByText('Check with Stripe…').click();
	await expect(openRow).toContainText('never creates a new charge');
	// Authorized against Invoice v2 while the booking is at Invoice v3: release is offered too.
	await expect(openRow.getByTestId('payment-attempt-terms')).toContainText(
		'It was started for Invoice v2; the current terms are Invoice v3.'
	);
	await expect(card(page).getByTestId('release-previous-checkout')).toBeVisible();
	await expect(openRow.getByTestId('reconcile-attempt')).toHaveText('Check payment status');
	await openRow.getByTestId('reconcile-attempt').click();
	await expect(card(page).getByTestId('customer-payments-status')).toContainText(
		'Stripe confirmed the previous checkout expired'
	);
	await expect(card(page).getByTestId('release-previous-checkout')).toHaveCount(0);
	await expect(rows.filter({ hasText: 'Expired' })).toHaveCount(1);
	expect(await page.content()).not.toContain('cs_test_private');
});

test('live Activity updates refresh displayed attempts and keep the composer draft', async ({
	page,
	context
}) => {
	await bookedWithAccess(page, context);
	await conversation(context, { updates: 'live' });
	await payments(context, { inquiryId: mayaId, access: {}, attempts: [] });
	await page.goto(route);
	await expect(page.getByTestId('live-status')).toHaveText('Live');
	await page.getByLabel('Message', { exact: true }).fill('Draft that must survive');
	await card(page)
		.getByText(/Online payment attempts \(0\)/)
		.click();
	await payments(context, {
		inquiryId: mayaId,
		attempts: [paymentAttemptFixture({ state: 'PROCESSING' })]
	});
	await conversation(context, { notify: true });
	await expect(card(page).getByTestId('payment-attempt')).toHaveCount(1);
	await expect(card(page).getByTestId('payment-attempt')).toContainText('Processing');
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Draft that must survive');
});

test('disabled Stripe and ambiguous mutations fail safely', async ({ page, context }) => {
	await bookedWithAccess(page, context);
	await payments(context, { mode: 'disabled' });
	await page.goto(route);
	await expect(card(page)).toContainText('Online payments are turned off in commerce');
	await expect(page.getByTestId('open-payment')).toBeVisible();
	await payments(context, { mode: 'mutation-500' });
	await page.reload();
	await card(page).getByTestId('create-payment-link').click();
	await expect(card(page).getByTestId('customer-payments-error')).toContainText(
		"We couldn't confirm the result"
	);
	await expect(card(page).getByRole('link', { name: 'Reload to review' })).toBeVisible();
	await expect(card(page).getByTestId('create-payment-link')).toBeDisabled();
	expect(
		(await payments(context)).calls.filter((c: { method: string }) => c.method === 'POST')
	).toHaveLength(1);
});
