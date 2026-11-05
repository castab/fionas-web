import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { postAction, route, session, signIn, stubUrl } from './request-helpers.js';
import { mayaDocumentId, mayaId, paymentFixture } from './request-fixture.mjs';

const EMAIL_PERMISSIONS = [
	'fionas.inquiries.read',
	'commerce.financial-document.read',
	'fionas.communications.read',
	'fionas.communications.send',
	'fionas.payment-access.manage'
];
const message = 'We would love to scoop at your garden party.\n\nReply with any questions!';

async function stub(context: BrowserContext, path: string, update?: unknown) {
	const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
	const response = update
		? await context.request.post(`${stubUrl}${path}`, { headers: { cookie }, data: update })
		: await context.request.get(`${stubUrl}${path}`, { headers: { cookie } });
	expect(response.ok()).toBe(true);
	return update ? null : response.json();
}
const emails = (context: BrowserContext) => stub(context, '/__test/financial-email');
const conversation = async (context: BrowserContext, update?: unknown) =>
	update
		? stub(context, '/__test/conversation', update)
		: (await stub(context, '/__test/conversation'))[mayaId];

function quoted() {
	const request = paymentFixture('quoted');
	request.currentQuoteRevision = 2;
	request.proposal!.quoteRevision = 2;
	return request;
}
function served(balance = '415.00') {
	const request = paymentFixture('served');
	request.currentQuoteRevision = 2;
	request.acceptedQuoteRevision = 2;
	request.currentInvoiceRevision = 3;
	request.financial.reconciliation.balance = balance;
	return request;
}
async function setup(
	page: Page,
	context: BrowserContext,
	request: unknown = quoted(),
	permissions = EMAIL_PERMISSIONS
) {
	await signIn(page);
	const current = await session(context);
	await session(context, {
		request,
		permissions: [
			...current.permissions.filter((p: string) => !EMAIL_PERMISSIONS.includes(p)),
			...permissions
		]
	});
	await conversation(context, { reset: true });
	await stub(context, '/__test/financial-email', { mode: 'accepted' });
}
/** Replaces the stub request and re-syncs its communication summary, as commerce would. */
async function replaceRequest(context: BrowserContext, request: unknown) {
	await session(context, { request });
	await conversation(context, {});
}
const panel = (page: Page) => page.getByTestId('financial-email-panel');
const status = (page: Page) => page.getByTestId('financial-email-status');
const recoveryCookies = async (context: BrowserContext) =>
	(await context.cookies()).filter((c) => c.name.startsWith('fionas_fe'));

async function openAndPreview(page: Page, text = message) {
	await page.goto(route);
	await status(page).getByRole('link', { name: 'Email quote' }).click();
	await expect(page).toHaveURL(`${route}?email`);
	await expect(panel(page)).toBeVisible();
	await page.getByLabel('Personal message (optional)').fill(text);
	await page.getByRole('button', { name: 'Preview email', exact: true }).click();
	await expect(panel(page).getByTestId('financial-email-review')).toBeVisible();
}

test('Quote: preview is inert and write-free, editing invalidates it, and an explicit send appears in Activity', async ({
	page,
	context
}, info) => {
	await setup(page, context);
	await page.goto(route);
	await expect(status(page)).toContainText('This Quote hasn’t been emailed');
	await expect(status(page)).toContainText('Publishing a Quote never emails it.');
	await openAndPreview(page);
	const review = panel(page).getByTestId('financial-email-review');
	// Authoritative recipient and money from commerce, staff-only identity.
	await expect(panel(page).getByTestId('email-recipient')).toContainText('Maya Torres');
	await expect(panel(page).getByTestId('email-document')).toHaveText('Quote v2 · revision 2');
	await expect(review.getByTestId('email-required')).toHaveText('$300');
	await expect(review.getByTestId('email-after-deposit')).toBeVisible();
	await expect(page.getByTestId('financial-email-status-message')).toContainText('Preview ready');

	// Isolated preview: scripts never run, links and refresh never navigate, no remote image loads.
	const frame = page.frameLocator('[data-testid="email-preview-frame"]');
	await expect(frame.locator('h1')).toHaveText('Hi Maya, here’s your quote');
	await expect(frame.locator('[data-message]')).toContainText('garden party');
	await expect(frame.locator('body')).not.toHaveAttribute('data-scripted', 'yes');
	const pages = context.pages().length;
	await frame.locator('#pay').click();
	await frame.locator('#self').click();
	await page.waitForTimeout(300);
	expect(context.pages()).toHaveLength(pages);
	await expect(frame.locator('h1')).toHaveText('Hi Maya, here’s your quote');
	expect(page.frames().every((f) => !f.url().includes('example.invalid'))).toBe(true);
	await expect(page.getByTestId('email-preview-text')).toBeHidden();
	await page.getByText('Show plain-text version').click();
	await expect(page.getByTestId('email-preview-text')).toContainText(
		'https://example.invalid/payment-preview'
	);
	let state = await emails(context);
	expect(state.previews).toHaveLength(1);
	expect(state.previews[0]).toEqual({
		kind: 'QUOTE',
		documentId: mayaDocumentId,
		expectedDocumentVersion: 2,
		expectedBusinessRevision: 2,
		proposalId: `3${mayaId.slice(1)}`,
		expectedDepositRequirementRevision: 1,
		message
	});
	expect(state.sends).toEqual([]);
	expect(state.pixelHits).toBe(0);
	// The sealed command is HttpOnly and scoped to this workspace.
	const cookies = await recoveryCookies(context);
	expect(cookies.length).toBeGreaterThan(0);
	for (const cookie of cookies) {
		expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: route });
		expect(cookie.value).not.toContain('garden');
	}

	// Editing the reviewed message immediately withdraws Send.
	const send = page.getByRole('button', { name: 'Send quote', exact: true });
	await expect(send).toBeEnabled();
	await page.getByLabel('Personal message (optional)').fill(`${message} See you soon.`);
	await expect(send).toHaveCount(0);
	await expect(page.getByTestId('financial-email-invalidated')).toContainText(
		'You changed the message after the preview'
	);
	await page.getByLabel('Personal message (optional)').fill(message);
	await expect(send).toBeEnabled();

	await page.screenshot({
		path: `test-results/financial-email-${info.project.name}.png`,
		fullPage: true
	});
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true
	);
	await send.click();
	await expect(page.getByTestId('financial-email-status-message')).toContainText(
		'Quote email accepted by the email provider. Delivery is not confirmed yet.'
	);
	const activity = page.getByTestId('conversation');
	await expect(activity.getByTestId('financial-email-chip')).toHaveText('Quote emailed');
	await expect(activity.getByText('Accepted by email provider', { exact: true })).toBeVisible();
	await expect(activity.getByText('Delivered', { exact: true })).toHaveCount(0);
	await expect(status(page).getByTestId('financial-email-summary')).toContainText(
		'Current Quote emailed'
	);
	await expect(status(page)).toContainText('Delivery not confirmed');
	// The newest message opens by itself.
	await expect(
		activity.locator('details:has([data-testid="financial-email-chip"])')
	).toHaveAttribute('open', '');
	await expect(activity.getByTestId('financial-email-meta')).toContainText(
		'Quote v2 · revision 2 (staff only) · Current Quote · Sent by you'
	);
	// Staff read the complete provider text, payment link included.
	await expect(
		activity.getByText(/Pay here: https:\/\/www\.fionasicecream\.example\/pay\//).last()
	).toBeVisible();
	state = await emails(context);
	expect(state.sends).toHaveLength(1);
	expect(state.sends[0].body).toMatchObject({
		email: state.previews[0],
		expectedLatestMessageId: '71000000-0000-0000-0000-000000000001'
	});
	expect(state.sends[0].body).not.toHaveProperty('expectEmptyConversation');
	expect(await recoveryCookies(context)).toEqual([]);

	// Needs reply is untouched by the send, and the customer's answer stays readable.
	await expect(activity.getByText('Needs reply', { exact: true })).toBeVisible();
	await conversation(context, { inbound: 'Looks great! Paying the deposit now.' });
	await activity.getByRole('button', { name: 'Refresh', exact: true }).click();
	await expect(
		activity.locator('details[open] p').filter({ hasText: 'Looks great! Paying the deposit now.' })
	).toBeVisible();
	// The ordinary reply composer is untouched beside it, its draft intact.
	await expect(page.getByRole('button', { name: 'Send reply', exact: true })).toBeVisible();
});

test('Quote: an emailed earlier revision is not shown as the current one', async ({
	page,
	context
}) => {
	await setup(page, context);
	await openAndPreview(page);
	await page.getByRole('button', { name: 'Send quote', exact: true }).click();
	await expect(status(page).getByTestId('financial-email-summary')).toContainText(
		'Current Quote emailed'
	);
	const revised = quoted();
	revised.currentQuoteRevision = 3;
	revised.proposal!.quoteRevision = 3;
	await replaceRequest(context, revised);
	await page.goto(route);
	await expect(status(page).getByTestId('financial-email-summary')).toContainText(
		'Only an earlier Quote was emailed (Quote v2 · revision 2'
	);
	await page.getByTestId('financial-email-chip').click();
	await expect(page.getByTestId('financial-email-meta')).toContainText('Earlier Quote');
});

test('Quote: a changed Quote revision invalidates the open preview and its send', async ({
	page,
	context
}) => {
	await setup(page, context);
	await openAndPreview(page);
	const revised = quoted();
	revised.currentQuoteRevision = 3;
	revised.proposal!.quoteRevision = 3;
	await replaceRequest(context, revised);
	// The open form still sends: commerce refuses the stale review and nothing is dispatched.
	await page.getByRole('button', { name: 'Send quote', exact: true }).click();
	await expect(page.getByTestId('financial-email-error')).toContainText(
		'changed since this preview'
	);
	await expect(page.getByTestId('financial-email-rejected')).toBeVisible();
	expect((await emails(context)).dispatched ?? 0).toBe(0);
	// Reloading shows the current revision; a fresh review is required.
	await page.reload();
	await expect(panel(page).getByTestId('email-document')).toHaveText('Quote v2 · revision 3');
	await page.getByRole('button', { name: 'Preview again', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Send quote', exact: true })).toBeEnabled();
	await expect(panel(page).getByTestId('email-document')).toHaveText('Quote v2 · revision 3');
});

test('UNKNOWN locks the exact command across reload and new mail, then reconciles it once', async ({
	page,
	context
}) => {
	await setup(page, context);
	await stub(context, '/__test/financial-email', { mode: 'unknown' });
	await openAndPreview(page);
	await page.getByRole('button', { name: 'Send quote', exact: true }).click();
	const reconcile = page.getByRole('button', { name: 'Reconcile original send', exact: true });
	await expect(reconcile).toBeEnabled();
	await expect(page.getByTestId('financial-email-locked')).toContainText('Send outcome unknown');
	await expect(page.getByLabel('Personal message (optional)')).toHaveAttribute('readonly', '');
	await expect(page.getByRole('button', { name: /Retry|Send quote|Preview/ })).toHaveCount(0);
	// The lock survives a reload (the panel reopens itself) and new correspondence.
	await conversation(context, { inbound: 'Did you send the quote?' });
	await page.goto(route);
	await expect(reconcile).toBeVisible();
	await expect(status(page).getByTestId('financial-email-unknown')).toContainText(
		'Send outcome unknown'
	);
	await expect(page.getByLabel('Personal message (optional)')).toHaveValue(message);
	// A crafted preview cannot replace the locked command.
	const refused = await postAction(page, `${route}?email&/previewFinancialEmail`, {
		kind: 'QUOTE',
		documentId: mayaDocumentId,
		expectedDocumentVersion: '2',
		expectedBusinessRevision: '2',
		proposalId: `3${mayaId.slice(1)}`,
		expectedDepositRequirementRevision: '1',
		expectedLatestMessageId: (await conversation(context)).timeline.conversation.latestMessageId,
		message: 'Something else'
	});
	expect(refused.status).toBe(409);
	await stub(context, '/__test/financial-email', { mode: 'accepted' });
	await reconcile.click();
	await expect(page.getByTestId('financial-email-status-message')).toContainText(
		'already accepted earlier; no new email was sent'
	);
	const state = await emails(context);
	expect(state.sends).toHaveLength(2);
	expect(state.sends[1]).toEqual(state.sends[0]);
	expect(state.sends[1].body.expectedLatestMessageId).toBe('71000000-0000-0000-0000-000000000001');
	expect(state.dispatched).toBe(1);
	await expect(page.getByTestId('conversation').getByTestId('financial-email-chip')).toHaveCount(1);
});

test('a lost response keeps the command, and reconciliation confirms the earlier acceptance', async ({
	page,
	context
}) => {
	await setup(page, context);
	await stub(context, '/__test/financial-email', { mode: 'lost' });
	await openAndPreview(page);
	await page.getByRole('button', { name: 'Send quote', exact: true }).click();
	await expect(page.getByTestId('financial-email-error')).toContainText(
		'may or may not have been sent'
	);
	await page.reload();
	const reconcile = page.getByRole('button', { name: 'Reconcile original send', exact: true });
	await expect(reconcile).toBeVisible();
	await reconcile.click();
	await expect(page.getByTestId('financial-email-status-message')).toContainText(
		'no new email was sent'
	);
	const state = await emails(context);
	expect(state.sends[1]).toEqual(state.sends[0]);
	expect(state.dispatched).toBe(1);
});

test('lost recovery state fails closed and never sends a new command', async ({
	page,
	context
}) => {
	await setup(page, context);
	await stub(context, '/__test/financial-email', { mode: 'unknown' });
	await openAndPreview(page);
	await page.getByRole('button', { name: 'Send quote', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Reconcile original send' })).toBeVisible();
	await context.clearCookies({ name: /^fionas_fe/ });
	await page.goto(route);
	await expect(status(page).getByTestId('financial-email-lost')).toBeVisible();
	await expect(status(page).getByTestId('open-financial-email')).toHaveCount(0);
	await expect(panel(page).getByTestId('financial-email-lost')).toBeVisible();
	await expect(page.getByRole('button', { name: /Preview|Send quote|Reconcile/ })).toHaveCount(0);
	const crafted = await postAction(page, `${route}?email&/sendFinancialEmail`, {
		reviewId: 'anything',
		message
	});
	expect(crafted.status).toBe(409);
	expect((await emails(context)).sends).toHaveLength(1);
});

test('tracking verification and provider refusals are explained without diagnostics', async ({
	page,
	context
}) => {
	await setup(page, context);
	await stub(context, '/__test/financial-email', { mode: 'tracking' });
	await openAndPreview(page);
	await page.getByRole('button', { name: 'Send quote', exact: true }).click();
	const error = page.getByTestId('financial-email-error');
	await expect(error).toContainText('FIONAS_FINANCIAL_EMAIL_LINKS_UNTRACKED=true');
	await expect(error).not.toContainText('PRIVATE');
	await stub(context, '/__test/financial-email', { mode: 'reject' });
	await page.getByRole('button', { name: 'Send quote', exact: true }).click();
	await expect(error).toContainText('definitively rejected');
	await expect(page.getByTestId('financial-email-rejected')).toBeVisible();
	await page.goto(route);
	await expect(status(page)).toContainText('was rejected by the email provider; it was not sent');
});

test('Invoice: SERVED with a balance offers Email invoice; other states never send', async ({
	page,
	context
}) => {
	await setup(page, context, served());
	await page.goto(route);
	await status(page).getByRole('link', { name: 'Email invoice' }).click();
	await page.getByRole('button', { name: 'Preview email', exact: true }).click();
	const review = panel(page).getByTestId('financial-email-review');
	await expect(review.getByTestId('email-required')).toHaveText('$415');
	await expect(review.getByTestId('email-balance')).toHaveText('$415');
	await expect(review.getByTestId('email-after-deposit')).toHaveCount(0);
	await page.getByRole('button', { name: 'Send invoice', exact: true }).click();
	await expect(status(page).getByTestId('financial-email-summary')).toContainText(
		'Current Invoice emailed'
	);
	expect((await emails(context)).sends[0].body.email).toEqual({
		kind: 'INVOICE',
		documentId: mayaDocumentId,
		expectedDocumentVersion: 3,
		expectedBusinessRevision: 3
	});

	// Fully paid: an explanation, never an action.
	await replaceRequest(context, served('0.00'));
	await page.goto(`${route}?email`);
	await expect(status(page).getByTestId('financial-email-unavailable')).toContainText(
		'no remaining balance'
	);
	await expect(status(page).getByTestId('open-financial-email')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Preview email' })).toHaveCount(0);

	const closed = served('0.00');
	closed.inquiry.lifecycle.stage = 'CLOSED';
	for (const request of [paymentFixture('booked'), closed]) {
		await replaceRequest(context, request);
		await page.goto(`${route}?email`);
		await expect(page.getByTestId('request-summary')).toBeVisible();
		await expect(status(page)).toHaveCount(0);
		await expect(panel(page)).toHaveCount(0);
	}
	const crafted = await postAction(page, `${route}?email&/previewFinancialEmail`, {
		kind: 'INVOICE',
		documentId: mayaDocumentId,
		expectedDocumentVersion: '3',
		expectedBusinessRevision: '3',
		expectedLatestMessageId: (await conversation(context)).timeline.conversation.latestMessageId
	});
	expect(crafted.status).toBe(409);
	expect((await emails(context)).sends).toHaveLength(1);
});

test('missing permissions suppress the actions and are refused server-side', async ({
	page,
	context
}) => {
	await setup(
		page,
		context,
		quoted(),
		EMAIL_PERMISSIONS.filter((p) => p !== 'fionas.payment-access.manage')
	);
	await page.goto(`${route}?email`);
	await expect(status(page)).toContainText('payment-access manage');
	await expect(status(page).getByTestId('open-financial-email')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Preview email' })).toHaveCount(0);
	const refused = await postAction(page, `${route}?email&/previewFinancialEmail`, {
		kind: 'QUOTE',
		documentId: mayaDocumentId,
		expectedDocumentVersion: '2',
		expectedBusinessRevision: '2',
		proposalId: `3${mayaId.slice(1)}`,
		expectedDepositRequirementRevision: '1',
		expectedLatestMessageId: '71000000-0000-0000-0000-000000000001'
	});
	expect(refused.status).toBe(403);
	expect((await emails(context)).previews).toEqual([]);
});

test('keyboard: the panel is operable and announces outcomes', async ({ page, context }) => {
	await setup(page, context);
	await page.goto(`${route}?email`);
	const field = page.getByLabel('Personal message (optional)');
	await expect(field).toBeFocused();
	await page.keyboard.type('Hello Maya');
	await page.keyboard.press('Tab');
	await expect(page.getByRole('button', { name: 'Preview email', exact: true })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('status').filter({ hasText: 'Preview ready' })).toBeFocused();
});

test.describe('without JavaScript', () => {
	test.use({ javaScriptEnabled: false });

	test('native preview and send follow PRG to the authoritative workspace', async ({
		page,
		context
	}) => {
		await setup(page, context);
		await page.goto(`${route}?email&from=filter%3Dquoted`);
		await page.getByLabel('Personal message (optional)').fill(message);
		await page.getByRole('button', { name: 'Preview email', exact: true }).click();
		await expect(panel(page).getByTestId('email-subject')).toBeVisible();
		await page.getByRole('button', { name: 'Send quote', exact: true }).click();
		await expect(page).toHaveURL(`${route}?from=filter%3Dquoted#financial-email-status`);
		await expect(page.getByTestId('financial-email-accepted')).toContainText(
			'Quote email accepted by the email provider.'
		);
		await expect(status(page).getByTestId('financial-email-summary')).toContainText(
			'Current Quote emailed'
		);
		const state = await emails(context);
		expect(state.sends).toHaveLength(1);
		expect(state.sends[0].body.email.message).toBe(message);
		// The one-time notice is gone after another load.
		await page.reload();
		await expect(page.getByTestId('financial-email-accepted')).toHaveCount(0);
	});
});
