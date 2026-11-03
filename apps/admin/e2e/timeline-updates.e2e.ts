import { test, expect, type BrowserContext } from '@playwright/test';
import { signIn, route, stubUrl, session, reviewQuote } from './request-helpers.js';
import { mayaId } from './request-fixture.mjs';
import {
	conversationFixture,
	milestoneFixture,
	customerMessageId
} from './conversation-fixture.mjs';

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

test('live history preserves composer, disclosures and workspace; disconnect releases subscriber', async ({
	page,
	context
}) => {
	await signIn(page);
	const initial = conversationFixture();
	const outboundId = '71000000-0000-0000-0000-000000000099';
	initial.items.push({
		...initial.items.find((i) => i.kind === 'MESSAGE')!,
		kind: 'MESSAGE',
		id: `message:${outboundId}`,
		messageId: outboundId,
		direction: 'outbound',
		senderAddress: 'bookings@fionas.example',
		recipient: 'maya@example.com',
		text: 'Staff response',
		sendState: 'accepted',
		deliveryState: 'unknown'
	});
	await conversation(context, { updates: 'live', timeline: initial });
	await page.goto(route);
	await expect(page.getByTestId('live-status')).toHaveText('Live');
	const card = page.getByTestId('conversation');
	await card.getByText('Quote v2 published', { exact: true }).click();
	const key = await page.locator('input[name="key"]').inputValue();
	await page.getByLabel('Message', { exact: true }).fill('Unfinished staff draft');
	await conversation(context, { inbound: 'A live customer question', notify: true });
	await expect(card.getByText('New customer email · Maya Torres', { exact: true })).toBeVisible();
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Unfinished staff draft');
	await expect(page.locator('input[name="key"]')).toHaveValue(key);
	await expect(card.getByText('Historical total', { exact: true })).toBeVisible();
	await expect(page.locator(`#message-${customerMessageId}`)).toHaveAttribute('open', '');
	await card.getByRole('button', { name: 'Dismiss', exact: true }).click();
	const updated = (await conversation(context)).timeline;
	updated.items.find((i: { id: string }) => i.id === `message:${outboundId}`).deliveryState =
		'delivered';
	updated.items.push(
		...milestoneFixture().items.filter((i) => !['QUOTE_PUBLISHED', 'MESSAGE'].includes(i.kind))
	);
	await conversation(context, { timeline: updated, notify: true });
	await expect(card.getByText('Event served', { exact: true })).toBeVisible();
	await expect(card.getByText('Refund recorded', { exact: true })).toBeVisible();
	await page.locator(`#message-${outboundId} > summary`).click();
	await expect(card.getByText('Delivered', { exact: true })).toBeVisible();
	await expect(card.getByText('Request details changed', { exact: false })).toBeVisible();
	await expect(card.getByText('Historical total', { exact: true }).first()).toBeVisible();
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Unfinished staff draft');
	await conversation(context, { closeStream: true });
	await expect.poll(async () => (await conversation(context)).subscriptions).toBe(2);
	await expect(page.getByTestId('live-status')).toHaveText('Live');
	await expect(card.getByText('New customer email · Maya Torres', { exact: true })).toHaveCount(0);
	await page.goto('/');
	await expect.poll(async () => (await conversation(context)).activeStreams).toBe(0);
});

for (const outage of ['temporary', 'gateway'])
	test(`${outage} placeholder does not refresh; real hook permits outage recovery without login redirect`, async ({
		page,
		context
	}) => {
		await signIn(page);
		await conversation(context, { updates: outage });
		await page.goto(route);
		await expect.poll(async () => (await conversation(context)).subscriptions).toBe(1);
		const reads = (await conversation(context)).timelineReads;
		await conversation(context, { authUnavailable: true });
		// Real HTTP request passes SvelteKit routing and hooks while /auth/me is failing.
		const result = await page.evaluate(async (path) => {
			const response = await fetch(path, { redirect: 'manual' });
			return {
				status: response.status,
				body: await response.text(),
				type: response.headers.get('content-type')
			};
		}, `${route}/updates`);
		expect(result.status).toBe(200);
		expect(result.type).toContain('text/event-stream');
		expect(result.body).toMatch(/^retry: [567]\d{3}\n\n$/);
		await expect
			.poll(async () => (await conversation(context)).subscriptions, { timeout: 15000 })
			.toBeGreaterThanOrEqual(3);
		expect((await conversation(context)).timelineReads).toBe(reads);
		await conversation(context, {
			authUnavailable: false,
			updates: 'live',
			inbound: 'Recovered after outage'
		});
		await expect(page.getByTestId('live-status')).toHaveText('Live', { timeout: 15000 });
		await expect(page.getByText('New customer email · Maya Torres', { exact: true })).toBeVisible();
		await expect(page).toHaveURL(route);
		await conversation(context, { inbound: 'After reconnection', notify: true });
		await expect(
			page
				.getByTestId('conversation')
				.getByText('After reconnection', { exact: true })
				.filter({ visible: true })
				.first()
		).toBeVisible();
	});

for (const updates of ['disabled', '401', '403', '404']) {
	test(`terminal ${updates} stops native reconnection and keeps manual refresh`, async ({
		page,
		context
	}) => {
		await signIn(page);
		await conversation(context, { updates });
		await page.goto(route);
		await expect(page.getByTestId('live-status')).toHaveText('Updates paused');
		expect((await conversation(context)).subscriptions).toBe(1);
		await conversation(context, { inbound: 'Manual fallback' });
		await page.getByRole('button', { name: 'Refresh conversation' }).click();
		await expect(page.getByText('New customer email · Maya Torres', { exact: true })).toBeVisible();
		expect((await conversation(context)).subscriptions).toBe(1);
	});
}

test('missing credentials fail closed at actual hook and route boundary', async ({ request }) => {
	const response = await request.get(`${route}/updates`, { maxRedirects: 0 });
	expect(response.status()).toBe(204);
	expect(await response.text()).toBe('');
	expect(response.headers().location).toBeUndefined();
	const page = await request.get(route, { maxRedirects: 0 });
	expect(page.status()).toBe(303);
	expect(page.headers().location).toBe('/login');
});

test('a hint during a delayed timeline read schedules another authoritative read', async ({
	page,
	context
}) => {
	await signIn(page);
	await conversation(context, { updates: 'live' });
	await page.goto(route);
	await expect(page.getByTestId('live-status')).toHaveText('Live');
	const before = (await conversation(context)).timelineReads;
	await conversation(context, { holdTimeline: true, notify: true });
	await expect.poll(async () => (await conversation(context)).timelineReads).toBe(before + 1);
	await page.getByRole('button', { name: 'Refresh conversation' }).click();
	await conversation(context, { inbound: 'Arrived during the read', notify: true });
	await conversation(context, { holdTimeline: false, releaseTimeline: true });
	await expect(page.getByText('New customer email · Maya Torres', { exact: true })).toBeVisible();
	await expect.poll(async () => (await conversation(context)).timelineReads).toBe(before + 2);
});

test('live updates never reconcile UNKNOWN or replace its key and original expectation', async ({
	page,
	context
}) => {
	await signIn(page);
	await conversation(context, { updates: 'live', mode: 'unknown' });
	await page.goto(route);
	await expect(page.getByTestId('live-status')).toHaveText('Live');
	await page.getByLabel('Message', { exact: true }).fill('Original uncertain command');
	await page.getByRole('button', { name: 'Send reply', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Reconcile original reply' })).toBeVisible();
	const first = (await conversation(context)).attempts[0];
	await conversation(context, { inbound: 'After UNKNOWN', notify: true });
	await expect(page.getByText('New customer email · Maya Torres', { exact: true })).toBeVisible();
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue(
		'Original uncertain command'
	);
	await expect(page.getByLabel('Message', { exact: true })).toHaveAttribute('readonly', '');
	expect((await conversation(context)).attempts).toEqual([first]);
	await conversation(context, { mode: 'accepted' });
	await page.getByRole('button', { name: 'Reconcile original reply' }).click();
	await expect(page.getByText('Accepted by email provider', { exact: true })).toBeVisible();
	expect((await conversation(context)).attempts).toEqual([first, first]);
});

test('read-only staff receive live history without send or acknowledge permissions', async ({
	page,
	context
}) => {
	await signIn(page);
	await session(context, {
		permissions: [
			'fionas.inquiries.read',
			'commerce.financial-document.read',
			'fionas.communications.read'
		]
	});
	await conversation(context, { updates: 'live' });
	await page.goto(route);
	await expect(page.getByTestId('live-status')).toHaveText('Live');
	await expect(page.getByRole('button', { name: 'Send reply', exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Mark as read', exact: true })).toHaveCount(0);
	await conversation(context, { inbound: 'Read-only notification', notify: true });
	await expect(page.getByText('New customer email · Maya Torres', { exact: true })).toBeVisible();
});

test('financial editor and its reviewed token survive live financial history', async ({
	page,
	context
}) => {
	await signIn(page);
	await conversation(context, { updates: 'live' });
	await page.goto(`${route}?quote`);
	await expect(page.getByTestId('live-status')).toHaveText('Live');
	await page.getByLabel('Approved service description').fill('Unfinished negotiated plan');
	await reviewQuote(page);
	const token = await page.locator('input[name="reviewToken"]').inputValue();
	await conversation(context, { timeline: milestoneFixture(), notify: true });
	await expect(page.getByText('Request details changed', { exact: false })).toBeVisible();
	await expect(page.getByLabel('Approved service description')).toHaveValue(
		'Unfinished negotiated plan'
	);
	await expect(page.locator('input[name="reviewToken"]')).toHaveValue(token);
	await expect(page.getByTestId('quote-builder')).toBeVisible();
});

test('first recovered history establishes the workspace baseline', async ({ page, context }) => {
	await signIn(page);
	await conversation(context, { updates: 'silent', mode: 'timeline-error' });
	await page.goto(route);
	await expect.poll(async () => (await conversation(context)).activeStreams).toBe(1);
	const card = page.getByTestId('conversation');
	const warning = card.getByText('Request details changed', { exact: false });
	const quote = card.getByText('Quote v2 published', { exact: true });
	await expect(quote).toHaveCount(0);
	await conversation(context, { mode: 'accepted', notify: true });
	await expect(quote).toBeVisible();
	await expect(warning).toHaveCount(0);
	await conversation(context, { inbound: 'After baseline', notify: true });
	await expect(card.getByText('New customer email · Maya Torres', { exact: true })).toBeVisible();
	await expect(warning).toHaveCount(0);
	const history = (await conversation(context)).timeline;
	const milestone = milestoneFixture().items;
	history.items.push(milestone.find((i) => i.kind === 'COMMUNICATION_ACKNOWLEDGED'));
	await conversation(context, { timeline: history, notify: true });
	await expect(card.getByText('Communication marked as read', { exact: true })).toBeVisible();
	await expect(warning).toHaveCount(0);
	history.items.push(milestone.find((i) => i.kind === 'INVOICE_AMENDED'));
	await conversation(context, { timeline: history, notify: true });
	await expect(warning).toBeVisible();
	await card.getByRole('button', { name: 'Refresh conversation' }).click();
	await expect(card.getByText('Conversation refreshed.', { exact: true })).toBeVisible();
	await expect(warning).toBeVisible();
	await page.reload();
	await expect(quote).toBeVisible();
	await expect(warning).toHaveCount(0);
});
