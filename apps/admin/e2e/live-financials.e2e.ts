import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { route, session, signIn, stubUrl } from './request-helpers.js';
import { mayaId, paymentFixture } from './request-fixture.mjs';
import { revisionFixture } from './revision-fixture.mjs';
import { conversationFixture, milestoneFixture, actor } from './conversation-fixture.mjs';

/*
 * A live Activity update that changes financial history re-reads the authoritative staff request
 * and refreshes Right now in place: no workspace reload, so drafts survive. An open review panel
 * keeps its reviewed snapshot and says it is stale instead.
 */

async function conversation(context: BrowserContext, update?: unknown) {
	const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
	const response =
		update === undefined
			? await context.request.get(`${stubUrl}/__test/conversation`, { headers: { cookie } })
			: await context.request.post(`${stubUrl}/__test/conversation`, {
					headers: { cookie },
					data: update
				});
	expect(response.ok()).toBe(true);
	return update === undefined ? (await response.json())[mayaId] : null;
}

async function bookedAndLive(page: Page, context: BrowserContext) {
	await signIn(page);
	await session(context, { request: paymentFixture('booked') });
	await conversation(context, { updates: 'live' });
}

/** Commerce records a further $100 payment: new projection plus a new Activity band. */
async function recordPaymentElsewhere(context: BrowserContext) {
	await session(context, { request: paymentFixture('additional') });
	const { timeline } = await conversation(context);
	const band = milestoneFixture().items.find((item) => item.kind === 'PAYMENT_RECORDED')!;
	timeline.items.push({ ...band, id: 'payment:live-e2e' });
	await conversation(context, { timeline, notify: true });
}

const balance = (page: Page) => page.getByTestId('request-balance');

test('a live payment updates Right now in place and keeps the reply draft', async ({
	page,
	context
}) => {
	await bookedAndLive(page, context);
	await page.goto(route);
	await expect(page.getByTestId('live-status')).toHaveText('Live');
	await expect(balance(page)).toContainText('$115');
	const composer = page.getByLabel('Message', { exact: true });
	await composer.fill('Draft that must survive');
	await page.evaluate(() => ((window as unknown as { marker: string }).marker = 'same page'));
	await recordPaymentElsewhere(context);
	await expect(balance(page)).toHaveText(/Balance\s*\$15$/);
	await expect(page.getByTestId('request-summary')).toContainText('$400');
	await expect(page.getByTestId('details-changed')).toHaveCount(0);
	await expect(composer).toHaveValue('Draft that must survive');
	expect(await page.evaluate(() => (window as unknown as { marker: string }).marker)).toBe(
		'same page'
	);
	// Exactly one extra authoritative read, through the workspace's own refresh endpoint.
	const reads = (await session(context)).readPaths.filter(
		(path: string) => path === `/staff/requests/${mayaId}`
	);
	expect(reads).toHaveLength(2);
});

test('an open payment panel keeps its reviewed snapshot and says it is stale', async ({
	page,
	context
}) => {
	await bookedAndLive(page, context);
	await page.goto(`${route}?payment`);
	await expect(page.getByTestId('live-status')).toHaveText('Live');
	await expect(page.locator('#record-payment')).toBeVisible();
	await recordPaymentElsewhere(context);
	await expect(page.getByTestId('details-changed')).toContainText(
		'changed while this panel was open'
	);
	await expect(balance(page)).toContainText('$115');
	await expect(page.getByTestId('details-changed').getByRole('link')).toHaveText(
		'Reload to review'
	);
});

test('a failed authoritative re-read falls back to the reload notice', async ({
	page,
	context
}) => {
	await bookedAndLive(page, context);
	await page.goto(route);
	await expect(page.getByTestId('live-status')).toHaveText('Live');
	await session(context, { mode: 'request-unavailable' });
	const { timeline } = await conversation(context);
	const band = milestoneFixture().items.find((item) => item.kind === 'PAYMENT_RECORDED')!;
	timeline.items.push({ ...band, id: 'payment:live-e2e' });
	await conversation(context, { timeline, notify: true });
	await expect(page.getByTestId('details-changed')).toContainText("couldn't be loaded");
	await expect(balance(page)).toContainText('$115');
});

test('message-only updates do not re-read the request', async ({ page, context }) => {
	await bookedAndLive(page, context);
	await page.goto(route);
	await expect(page.getByTestId('live-status')).toHaveText('Live');
	await conversation(context, { inbound: 'Just a question', notify: true });
	await expect(page.getByText('New customer email', { exact: false })).toBeVisible();
	const reads = (await session(context)).readPaths.filter(
		(path: string) => path === `/staff/requests/${mayaId}`
	);
	expect(reads).toHaveLength(1);
});

test('a live topping swap shows separate Quote milestones for the same snapshot', async ({
	page,
	context
}) => {
	await signIn(page);
	const before = revisionFixture('quote-with-almonds');
	const after = revisionFixture('quote-service-revision');
	const timeline = conversationFixture();
	const first = timeline.items.find((item) => item.kind === 'QUOTE_PUBLISHED')!;
	first.proposal = before.proposal!;
	first.financial = before.financial;
	if (before.depositRequirement.state !== 'ACTIVE') throw new Error('Missing fixture deposit');
	const { satisfied, ...depositRequirement } = before.depositRequirement;
	void satisfied;
	first.depositRequirement = depositRequirement;
	await session(context, { request: before });
	await conversation(context, { updates: 'live', timeline });
	await page.goto(route);
	await expect(page.getByTestId('live-status')).toHaveText('Live');
	const activity = page.getByTestId('conversation');
	const earlier = activity.locator('details').filter({ hasText: 'Quote v2 published' });
	await expect(earlier.locator('summary')).toContainText('Current');
	await earlier.locator('summary').click();
	await expect(earlier.getByText('Sliced almonds')).toBeVisible();

	await session(context, { request: after });
	timeline.items.splice(1, 0, {
		...first,
		id: `quote:${after.proposal!.id}`,
		occurredAt: after.proposal!.issuedAt,
		proposal: after.proposal!
	});
	await conversation(context, { timeline, notify: true });

	const latest = activity.locator('details').filter({ hasText: 'Quote v3 published' });
	await expect(earlier.locator('summary')).toContainText('Superseded');
	await expect(latest.locator('summary')).toContainText('Current');
	await expect(page.getByTestId('request-summary')).toContainText('Quote v3 issued');
	await expect(earlier.getByText('Sliced almonds')).toBeVisible();
	await latest.locator('summary').click();
	await expect(latest.getByText('Chopped peanuts')).toBeVisible();
	for (const publication of [earlier, latest]) {
		await expect(publication.locator('summary')).toContainText('$415');
		await expect(publication).toContainText('Financial snapshot v2');
		await expect(publication).toContainText('Deposit to hold the date');
		await expect(publication).toContainText('$300');
	}
});

test('a live service-only Invoice amendment shows its own business revision', async ({
	page,
	context
}) => {
	await signIn(page);
	await session(context, { request: revisionFixture('booked') });
	await conversation(context, { updates: 'live' });
	await page.goto(route);
	await expect(page.getByTestId('live-status')).toHaveText('Live');
	await expect(page.getByTestId('financial-version')).toHaveText('Invoice v3');
	const request = revisionFixture('invoice-service-amendment');
	const amendment = request.invoiceAmendmentHistory[1];
	await session(context, { request });
	const { timeline } = await conversation(context);
	timeline.items.push({
		kind: 'INVOICE_AMENDED',
		id: amendment.id,
		occurredAt: amendment.approvedAt,
		financial: request.financial,
		amendment,
		actor
	});
	await conversation(context, { timeline, notify: true });
	await expect(page.getByTestId('financial-version')).toHaveText('Invoice v4');
	const band = page
		.getByTestId('conversation')
		.locator('details')
		.filter({ hasText: 'Invoice v4 amended' });
	await band.locator('summary').click();
	await expect(band).toContainText('Financial snapshot v3');
	await expect(band.getByText('Chocolate topping instead of vanilla')).toBeVisible();
	await page.getByTestId('financial-history-link').click();
	await expect(page.getByTestId('history-invoices')).toContainText('Invoice v4');
	await expect(page.getByTestId('history-versions')).toContainText('Invoice financial snapshot v3');
});
