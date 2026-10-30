import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { postAction, signIn, route, session, stubUrl } from './request-helpers.js';
import {
	conversationFixture,
	customerMessageId,
	milestoneFixture
} from './conversation-fixture.mjs';
import { mayaId } from './request-fixture.mjs';
import { revisionFixture } from './revision-fixture.mjs';

async function conversation(context: BrowserContext, update?: unknown) {
	const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
	const response = update
		? await context.request.post(`${stubUrl}/__test/conversation`, {
				headers: { cookie },
				data: update
			})
		: await context.request.get(`${stubUrl}/__test/conversation`, { headers: { cookie } });
	expect(response.ok()).toBe(true);
	return update ? null : (await response.json())[mayaId];
}

test('conversation journey preserves Requests context, historical snapshot, statuses and attention', async ({
	page,
	context
}, info) => {
	await signIn(page);
	await session(context, { request: revisionFixture('quote-financial-revision') });
	await conversation(context, {});
	await page.goto('/requests?filter=quoted&q=Maya');
	await expect(page.getByText('Needs reply', { exact: true })).toBeVisible();
	await page.getByTestId('request-row').click();
	const card = page.getByTestId('conversation');
	await expect(card.getByText('Needs reply', { exact: true })).toBeVisible();
	await card.getByText('Quote v2 published', { exact: true }).click();
	await expect(card.getByText('Historical total', { exact: true })).toBeVisible();
	await expect(page.locator(`#message-${customerMessageId}`)).toHaveAttribute('open', '');
	await page
		.getByLabel('Message', { exact: true })
		.fill('Yes, we can set up in the garden.\nSee you there!');
	await page.getByRole('button', { name: 'Send reply', exact: true }).click();
	await expect(card.getByText('Accepted by email provider', { exact: true })).toBeVisible();
	await expect(card.getByText('Delivery not confirmed', { exact: true })).toBeVisible();
	await expect(card.getByText('Delivered', { exact: true })).toHaveCount(0);
	await page.reload();
	await expect(card.getByText('Accepted by email provider', { exact: true })).toBeVisible();
	await conversation(context, { inbound: 'Thank you! Can we add a table?' });
	await page.getByRole('button', { name: 'Refresh conversation' }).click();
	await expect(card.getByText('Needs reply', { exact: true })).toBeVisible();
	await expect(card.getByText('New customer email · Maya Torres', { exact: true })).toBeVisible();
	await page.screenshot({
		path: `test-results/conversation-${info.project.name}.png`,
		fullPage: true
	});
	await card.screenshot({ path: `test-results/conversation-card-${info.project.name}.png` });
	const observed = (await conversation(context)).timeline.attention.throughRecordedOrder;
	await page.getByRole('button', { name: 'Mark as read', exact: true }).click();
	await expect(card.getByText('Needs reply', { exact: true })).toHaveCount(0);
	expect((await conversation(context)).acknowledgements).toEqual([
		{ throughRecordedOrder: observed }
	]);
	await page.getByRole('link', { name: 'Back to requests' }).click();
	await expect(page).toHaveURL(/\/requests\?filter=quoted&q=Maya$/);
});

test('UNKNOWN survives refresh and reload, then reconciles the original command once', async ({
	page,
	context
}) => {
	await signIn(page);
	await conversation(context, { mode: 'unknown' });
	await page.goto(route);
	await page.getByLabel('Message', { exact: true }).fill('Keep this original reply.');
	await page.getByRole('button', { name: 'Send reply', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Reconcile original reply' })).toBeVisible();
	await expect(page.getByLabel('Message', { exact: true })).toHaveAttribute('readonly', '');
	const first = (await conversation(context)).attempts[0];
	await conversation(context, {
		inbound: 'Another question arrived during the uncertain send.',
		mode: 'accepted'
	});
	await page.reload();
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue(
		'Keep this original reply.'
	);
	await page.getByRole('button', { name: 'Reconcile original reply' }).click();
	await expect(page.getByText('Accepted by email provider', { exact: true })).toBeVisible();
	const state = await conversation(context);
	expect(state.attempts).toEqual([first, first]);
	expect(
		state.timeline.items.filter((i: { direction?: string }) => i.direction === 'outbound')
	).toHaveLength(1);
	await expect(
		page.getByTestId('conversation').getByText('Needs reply', { exact: true })
	).toBeVisible();
});

test('stale acknowledgement never clears unseen customer communication', async ({
	page,
	context
}) => {
	await signIn(page);
	await conversation(context, {});
	await page.goto(route);
	await conversation(context, { inbound: 'Unseen email' });
	await page.getByRole('button', { name: 'Mark as read', exact: true }).click();
	await expect(
		page.getByRole('status').filter({ hasText: 'New customer communication arrived' })
	).toBeVisible();
	const state = await conversation(context);
	expect(state.acknowledgements).toEqual([{ throughRecordedOrder: 12 }]);
	expect(state.timeline.attention.needsReply).toBe(true);
});

test('refresh preserves open disclosures and draft; stale send needs explicit review', async ({
	page,
	context
}) => {
	await signIn(page);
	await conversation(context, {});
	await page.goto(route);
	await page.getByText('Quote v2 published', { exact: true }).click();
	await page.getByLabel('Message', { exact: true }).fill('Garden setup confirmed.');
	await conversation(context, { inbound: 'We changed the location.' });
	await page.getByRole('button', { name: 'Refresh conversation' }).click();
	await expect(page.getByText('Historical total', { exact: true })).toBeVisible();
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Garden setup confirmed.');
	await page.getByRole('button', { name: 'Send reply', exact: true }).click();
	await expect(
		page.getByRole('status').filter({ hasText: 'New communication arrived' })
	).toBeVisible();
	await page.getByRole('button', { name: 'I reviewed the conversation' }).click();
	await expect(page.getByLabel('Message', { exact: true })).toBeEditable();
	await page.getByRole('button', { name: 'Send reply', exact: true }).click();
	await expect(page.getByText('Accepted by email provider', { exact: true })).toBeVisible();
	const state = await conversation(context);
	expect(state.attempts).toHaveLength(2);
	expect(state.attempts[0].key).not.toBe(state.attempts[1].key);
});

for (const availability of ['EMPTY', 'MISSING', 'UNAVAILABLE', 'FORBIDDEN'] as const) {
	test(`${availability} keeps booking and history available with honest reply eligibility`, async ({
		page,
		context
	}) => {
		await signIn(page);
		await conversation(context, { availability });
		await page.goto(route);
		await expect(page.getByRole('heading', { level: 1, name: 'Maya Torres' })).toBeVisible();
		await expect(page.getByText('Quote v2 published', { exact: true })).toBeVisible();
		if (availability === 'EMPTY') {
			await page.getByLabel('Message', { exact: true }).fill('Thank you for your inquiry!');
			await page.getByRole('button', { name: 'Send reply', exact: true }).click();
			await expect(page.getByText('Accepted by email provider', { exact: true })).toBeVisible();
			expect((await conversation(context)).attempts[0].body.expectEmptyConversation).toBe(true);
		} else
			await expect(page.getByRole('button', { name: 'Send reply', exact: true })).toHaveCount(0);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true
		);
	});
}

test('null text, long addresses, escaped markup and permission gaps', async ({ page, context }) => {
	await signIn(page);
	const timeline = conversationFixture();
	const message = timeline.items[1];
	if (message.kind === 'MESSAGE') {
		message.text = null;
		message.senderAddress = 'very.long.'.repeat(15) + '@example.com';
	}
	await conversation(context, { timeline });
	await page.goto(route);
	await expect(
		page
			.getByTestId('conversation')
			.getByText('Plain-text content is unavailable for this email.')
			.filter({ visible: true })
			.first()
	).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await conversation(context, {
		inbound: '<script>alert("hello")</script>\nhttps://example.com/' + 'x'.repeat(200)
	});
	await page.getByRole('button', { name: 'Refresh conversation' }).click();
	await expect(
		page
			.getByTestId('conversation')
			.getByText(/<script>alert/)
			.filter({ visible: true })
			.first()
	).toBeVisible();
	const state = await session(context);
	await session(context, {
		permissions: state.permissions.filter((p: string) => p !== 'fionas.communications.read')
	});
	await page.reload();
	await expect(page.getByText('Email content is not accessible', { exact: false })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Send reply', exact: true })).toHaveCount(0);
	await expect(page.getByTestId('conversation').getByText(/<script>alert/)).toHaveCount(0);
});

test('malformed optional timeline does not hide financial controls', async ({ page, context }) => {
	await signIn(page);
	await conversation(context, { mode: 'malformed' });
	await page.goto(route);
	await expect(page.getByRole('heading', { level: 1, name: 'Maya Torres' })).toBeVisible();
	await expect(page.getByTestId('build-quote')).toBeVisible();
	await expect(page.getByText('Email is temporarily unavailable.', { exact: false })).toBeVisible();
	await conversation(context, { mode: 'accepted' });
	await page.getByRole('button', { name: 'Refresh conversation' }).click();
	await expect(page.getByText('Customer email', { exact: true })).toBeVisible();
	await expect(page.getByText('New customer email · Maya Torres', { exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Prepare reply', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Send reply', exact: true })).toBeEnabled();
});

test.describe('native conversation', () => {
	test.use({ javaScriptEnabled: false });
	test('reads, sends, preserves uncertain intent, and acknowledges without JavaScript', async ({
		page,
		context
	}) => {
		await signIn(page);
		await conversation(context, { mode: 'unknown' });
		await page.goto(route);
		await page.getByText('Quote v2 published', { exact: true }).click();
		await expect(page.getByText('Historical total', { exact: true })).toBeVisible();
		await page.getByLabel('Message', { exact: true }).fill('Native reply\nwith two lines.');
		await page.getByRole('button', { name: 'Send reply', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Reconcile original reply' })).toBeVisible();
		await conversation(context, { mode: 'accepted' });
		await page.getByRole('button', { name: 'Reconcile original reply' }).click();
		await expect(page.getByText('Accepted by email provider', { exact: true })).toBeVisible();
		await conversation(context, { inbound: 'A new native message' });
		await page.getByRole('button', { name: 'Refresh conversation' }).click();
		await page.getByRole('button', { name: 'Mark as read', exact: true }).click();
		await expect(
			page.getByTestId('conversation').getByText('Needs reply', { exact: true })
		).toHaveCount(0);
	});
});

for (const stage of ['unquoted', 'quoted', 'booked', 'served', 'closed', 'declined'] as const) {
	test(`conversation remains available at ${stage} without restoring financial actions`, async ({
		page,
		context
	}) => {
		await signIn(page);
		await session(context, { request: revisionFixture(stage) });
		await conversation(context, {});
		await page.goto(route);
		await expect(page.getByRole('heading', { name: 'Conversation', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Send reply', exact: true })).toBeEnabled();
		if (stage === 'closed' || stage === 'declined') {
			await expect(page.getByTestId('build-quote')).toHaveCount(0);
			await expect(page.getByRole('button', { name: 'Record payment', exact: true })).toHaveCount(
				0
			);
		}
	});
}

test('conversation milestone bands expose historical allocations and internal provenance', async ({
	page,
	context
}) => {
	await signIn(page);
	await conversation(context, { timeline: milestoneFixture() });
	await page.goto(route);
	const card = page.getByTestId('conversation');
	for (const label of [
		'Quote v2 published',
		'Invoice v4 amended',
		'Deposit received',
		'Additional payment received',
		'Refund recorded',
		'Communication marked as read',
		'Event served',
		'Event closed',
		'Request declined'
	]) {
		await card.getByText(label, { exact: true }).first().click();
	}
	await expect(card.getByText('Internal reason:', { exact: true })).toBeVisible();
	await expect(card.getByText('$10 unwound from document v3', { exact: false })).toBeVisible();
	await expect(card.getByText('$83 applied to QUOTE v2', { exact: false })).toBeVisible();
	await expect(card.getByText('Historical total', { exact: true })).toHaveCount(2);
});

test('conversation keyboard submission keeps Enter as a newline and exposes one live status', async ({
	page,
	context
}) => {
	await signIn(page);
	await conversation(context, {});
	await page.goto(route);
	const body = page.getByLabel('Message', { exact: true });
	await page.getByRole('link', { name: 'Reply', exact: true }).click();
	await expect(body).toBeFocused();
	await body.fill('Hello');
	await body.press('Enter');
	await body.press('M');
	expect((await conversation(context)).attempts).toHaveLength(0);
	await body.press('Control+Enter');
	await expect(page.getByText('Accepted by email provider', { exact: true })).toBeVisible();
	expect((await conversation(context)).attempts[0].body.body).toBe('Hello\nM');
	await expect(page.getByTestId('conversation').getByRole('status')).toHaveCount(1);
});

const strip = (page: Page) =>
	page.getByTestId('conversation').getByText('Customer message needs attention.');
const markAsRead = (page: Page) => page.getByRole('button', { name: 'Mark as read', exact: true });

for (const javaScriptEnabled of [true, false]) {
	test.describe(`acknowledgement gate (${javaScriptEnabled ? 'enhanced' : 'native'})`, () => {
		test.use({ javaScriptEnabled });
		for (const blocked of ['FORBIDDEN', 'UNAVAILABLE', 'outage'] as const)
			test(`${blocked} keeps Needs reply visible but not acknowledgeable`, async ({
				page,
				context
			}) => {
				await signIn(page);
				await conversation(
					context,
					blocked === 'outage' ? { mode: 'timeline-error' } : { availability: blocked }
				);
				await page.goto(route);
				await expect(strip(page)).toBeVisible();
				await expect(
					page.getByText('Mark as read becomes available once', { exact: false })
				).toBeVisible();
				await expect(markAsRead(page)).toHaveCount(0);
				expect((await conversation(context)).acknowledgements).toEqual([]);
			});

		test('a provider outage after loading refuses acknowledgement and keeps attention', async ({
			page,
			context
		}) => {
			await signIn(page);
			await conversation(context, {});
			await page.goto(route);
			await conversation(context, { mode: 'timeline-error' });
			await markAsRead(page).click();
			await expect(page.getByText('cannot be reviewed right now', { exact: false })).toBeVisible();
			await expect(strip(page)).toBeVisible();
			expect((await conversation(context)).acknowledgements).toEqual([]);
		});

		test('Mark as read keeps an unsent draft, which then sends once', async ({ page, context }) => {
			await signIn(page);
			await conversation(context, {});
			await page.goto(route);
			const body = page.getByLabel('Message', { exact: true });
			await body.fill('Half-written reply\nabout the garden');
			await markAsRead(page).click();
			await expect(strip(page)).toHaveCount(0);
			await expect(body).toHaveValue('Half-written reply\nabout the garden');
			const state = await conversation(context);
			expect(state.acknowledgements).toEqual([{ throughRecordedOrder: 12 }]);
			expect(state.attempts).toEqual([]);
			await page.getByRole('button', { name: 'Send reply', exact: true }).click();
			await expect(page.getByText('Accepted by email provider', { exact: true })).toBeVisible();
			expect((await conversation(context)).attempts.map((a: { body: unknown }) => a.body)).toEqual([
				{ body: 'Half-written reply\nabout the garden', expectedLatestMessageId: customerMessageId }
			]);
		});
	});
}

test('the server refuses crafted acknowledgements while messages are unreviewable', async ({
	page,
	context
}) => {
	await signIn(page);
	await conversation(context, {});
	await page.goto(route);
	await conversation(context, { availability: 'UNAVAILABLE' });
	expect(
		await postAction(page, `${route}?/acknowledgeConversation`, { throughRecordedOrder: '12' })
	).toMatchObject({ status: 409 });
	const state = await session(context);
	await session(context, {
		permissions: state.permissions.filter((p: string) => p !== 'fionas.communications.read')
	});
	expect(
		await postAction(page, `${route}?/acknowledgeConversation`, { throughRecordedOrder: '12' })
	).toMatchObject({ status: 403 });
	expect((await conversation(context)).acknowledgements).toEqual([]);
});

test('a reply pointer this server never issued fails closed instead of minting a key', async ({
	page,
	context
}) => {
	await signIn(page);
	await conversation(context, {});
	await context.addCookies([
		{
			name: 'fionas_reply_intent',
			value: '00000000-0000-4000-8000-000000000000',
			domain: '127.0.0.1',
			path: route
		}
	]);
	await page.goto(route);
	await expect(
		page.getByText('The original send intent is no longer available', { exact: false })
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'Send reply', exact: true })).toHaveCount(0);
	expect((await conversation(context)).attempts).toEqual([]);
});
