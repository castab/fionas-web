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

/** Email quote / Email invoice: in Right now's secondary actions, never in the status block. */
const openEmail = (page: Page) => page.getByTestId('open-financial-email');

async function openAndPreview(page: Page, text = message) {
	await page.goto(route);
	await openEmail(page).click();
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
	await expect(status(page).getByTestId('financial-email-summary')).toHaveText(
		'This Quote hasn’t been emailed. Publishing it didn’t send anything.'
	);
	await expect(status(page).getByRole('link')).toHaveCount(0);
	await openAndPreview(page);
	await expect(panel(page).getByTestId('financial-email-intro')).toHaveText(
		'Sends the current Quote to Maya in this booking’s email thread, with their payment link. Nothing goes out until you press Send quote.'
	);
	await expect(panel(page)).not.toContainText('records no payment');
	await expect(page.getByLabel('Personal message (optional)')).toHaveAttribute(
		'placeholder',
		'Leave blank for our standard greeting.'
	);
	await expect(page.locator('#financial-email-message-help')).toContainText(
		'Plain text. Leave a blank line to start a new paragraph. It shows above the Quote; if you change it after previewing, preview again.'
	);
	const review = panel(page).getByTestId('financial-email-review');
	// Authoritative recipient and money from commerce, staff-only identity.
	await expect(panel(page).getByTestId('email-recipient')).toContainText('Maya Torres');
	await expect(panel(page).locator('dt', { hasText: 'Sending' })).toBeVisible();
	await expect(panel(page).getByText('Document (staff only)')).toHaveCount(0);
	// One staff label: the document version, as everywhere else in the console.
	await expect(panel(page).getByTestId('email-document')).toHaveText('Quote v2');
	await expect(review).toContainText(
		'The real email uses Maya’s own payment link. Customers never see version numbers.'
	);
	await expect(page.getByTestId('email-preview')).toContainText(
		'Preview only — links and images are turned off, and the payment button goes nowhere.'
	);
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
	await expect(page.getByText('Hide plain-text version')).toBeVisible();

	// A bigger preview: 720px by default, a tall fixed height for the whole email (the opaque
	// sandbox can't be measured, and is never loosened to auto-size).
	const frameElement = page.getByTestId('email-preview-frame');
	const height = async () => (await frameElement.boundingBox())!.height;
	expect(await height()).toBeCloseTo(720, 0);
	await expect(frameElement).toHaveAttribute('sandbox', '');
	await page.getByText('Show the whole email').click();
	await expect(page.getByText('Shorter preview')).toBeVisible();
	await expect.poll(height).toBeCloseTo(1800, 0);
	await expect(frameElement).toHaveAttribute('scrolling', 'no');
	await page.getByText('Shorter preview').click();
	await expect.poll(height).toBeCloseTo(720, 0);
	await expect(frameElement).toHaveAttribute('scrolling', 'auto');

	// Phone: the email at 375px inside a simple handset outline; Desktop has none.
	const device = page.getByTestId('email-preview-device');
	await expect(device).toHaveAttribute('data-device', 'desktop');
	await expect(page.getByTestId('email-preview-speaker')).toHaveCount(0);
	await page.getByRole('button', { name: 'Phone', exact: true }).click();
	await expect(device).toHaveAttribute('data-device', 'phone');
	const speaker = page.getByTestId('email-preview-speaker');
	await expect(speaker).toBeVisible();
	const speakerBox = (await speaker.boundingBox())!;
	expect(speakerBox.width).toBeCloseTo(64, 0);
	expect(speakerBox.height).toBeCloseTo(5, 0);
	const outline = await device.evaluate((el) => {
		const style = getComputedStyle(el);
		return {
			radius: style.borderTopLeftRadius,
			padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
			background: style.backgroundColor,
			ink700: getComputedStyle(document.documentElement).getPropertyValue('--ink-700').trim()
		};
	});
	expect(outline.radius).toBe('16px');
	expect(outline.padding).toEqual(['12px', '12px', '18px', '12px']);
	expect(outline.ink700).not.toBe('');
	const frameWidth = (await frameElement.boundingBox())!.width;
	const deviceWidth = (await device.boundingBox())!.width;
	// 375px inside the outline whenever the panel is wide enough; never wider than the page.
	if (deviceWidth >= 399) expect(frameWidth).toBeCloseTo(375, 0);
	else expect(frameWidth).toBeLessThan(375);
	await expect(frameElement).toHaveCSS('border-top-left-radius', '10px');
	await page.getByRole('button', { name: 'Desktop', exact: true }).click();
	await expect(device).toHaveAttribute('data-device', 'desktop');
	await expect(frameElement).toHaveCSS('border-top-left-radius', '0px');
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
	await expect(page.getByTestId('financial-email-invalidated')).toHaveText(
		'You changed the message. Preview again to check it before sending.'
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
	// Accepted: the panel closes (replacing the ?email history entry) and Right now confirms it.
	await expect(panel(page)).toHaveCount(0);
	await expect(page).toHaveURL(route);
	const notice = page.getByTestId('financial-email-accepted');
	await expect(notice).toHaveText(
		'Sent just now. See it in Activity; it shows as delivered once the email provider confirms.'
	);
	await expect(notice).toBeFocused();
	await expect(status(page)).toContainText('Sent just now.');
	const activity = page.getByTestId('conversation');
	await expect(activity.getByTestId('financial-email-chip')).toHaveText('Quote emailed');
	await expect(activity.getByText('Accepted by email provider', { exact: true })).toBeVisible();
	await expect(activity.getByText('Delivered', { exact: true })).toHaveCount(0);
	await expect(status(page).getByTestId('financial-email-summary')).toHaveText(
		/^This Quote was emailed to Maya .+ Pacific by you\.$/
	);
	await expect(status(page)).toContainText('Delivery not confirmed');
	// The link leads to the Activity message once it has arrived.
	const messageId = await activity
		.locator('details:has([data-testid="financial-email-chip"])')
		.getAttribute('id');
	const link = notice.getByRole('link', { name: 'See it in Activity' });
	await expect(link).toHaveAttribute('href', `#${messageId}`);
	await link.click();
	await expect(page).toHaveURL(`${route}#${messageId}`);
	await expect(activity.locator(`#${messageId}`)).toBeInViewport();
	// Back from the message lands on the closed workspace: the ?email entry was replaced.
	await page.goBack();
	await expect(page).toHaveURL(route);
	await expect(panel(page)).toHaveCount(0);
	// The newest message opens by itself.
	await expect(
		activity.locator('details:has([data-testid="financial-email-chip"])')
	).toHaveAttribute('open', '');
	await expect(activity.getByTestId('financial-email-meta')).toContainText(
		'Quote v2 (staff only) · Current Quote · Sent by you'
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

	// Reopening says it was already sent, and that sending again emails another copy.
	await openEmail(page).click();
	await expect(page).toHaveURL(`${route}?email`);
	await expect(panel(page).getByTestId('financial-email-already')).toHaveText(
		/^Maya already got this Quote on .+ Pacific\. Sending again emails them another copy\.$/
	);
	await expect(page.getByTestId('financial-email-accepted')).toHaveCount(0);
});

test('Quote: an emailed earlier revision is not shown as the current one', async ({
	page,
	context
}) => {
	await setup(page, context);
	await openAndPreview(page);
	await page.getByRole('button', { name: 'Send quote', exact: true }).click();
	await expect(status(page).getByTestId('financial-email-summary')).toContainText(
		'This Quote was emailed to Maya'
	);
	const revised = quoted();
	revised.currentQuoteRevision = 3;
	revised.proposal!.quoteRevision = 3;
	await replaceRequest(context, revised);
	await page.goto(route);
	// Same ledger version, new business revision: commerce's current flag says it is earlier.
	await expect(status(page).getByTestId('financial-email-summary')).toHaveText(
		/^Only an earlier Quote was emailed \(Quote v2, .+ Pacific\)\. The current one hasn’t been sent\.$/
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
	// Rejected keeps the panel open.
	await expect(page.getByTestId('financial-email-rejected')).toHaveText(
		'That send was refused, so nothing went out. Preview again to start a new one.'
	);
	await expect(panel(page)).toBeVisible();
	await expect(page).toHaveURL(`${route}?email`);
	await expect(page.getByTestId('financial-email-accepted')).toHaveCount(0);
	expect((await emails(context)).dispatched ?? 0).toBe(0);
	// Reloading reviews the current revision; a fresh review is required. The label is the same
	// ledger version ("Quote v2"); the business revision lives in the identity, not the label.
	await page.reload();
	const revisionField = panel(page).locator('input[name="expectedBusinessRevision"]');
	await expect(panel(page).getByTestId('email-document')).toHaveText('Quote v2');
	await expect(revisionField).toHaveValue('3');
	await page.getByRole('button', { name: 'Preview again', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Send quote', exact: true })).toBeEnabled();
	await expect(panel(page).getByTestId('email-document')).toHaveText('Quote v2');
	expect((await emails(context)).previews.at(-1).expectedBusinessRevision).toBe(3);
});

test('UNKNOWN locks the exact command across reload and new mail, then reconciles it once', async ({
	page,
	context
}) => {
	await setup(page, context);
	await stub(context, '/__test/financial-email', { mode: 'unknown' });
	await openAndPreview(page);
	await page.getByRole('button', { name: 'Send quote', exact: true }).click();
	const reconcile = page.getByRole('button', { name: 'Check again', exact: true });
	await expect(reconcile).toBeEnabled();
	// Unknown keeps the panel open, locked to Check again.
	await expect(panel(page)).toBeVisible();
	await expect(page.getByTestId('financial-email-accepted')).toHaveCount(0);
	await expect(page.getByTestId('financial-email-locked')).toHaveText(
		'We can’t tell if this email went out. Check again to find out. Checking never sends a second copy: if the first one went out, nothing new is sent; if it didn’t, it goes out now. The message can’t be changed until then.'
	);
	await expect(page.getByTestId('financial-email-footnote')).toHaveText(
		/^Previewed .+ Pacific · Send ID [0-9a-f-]{36}\. This browser keeps the previewed email for 30 days so it can be checked; check again before then\.$/
	);
	await expect(page.getByLabel('Personal message (optional)')).toHaveAttribute('readonly', '');
	await expect(page.getByRole('button', { name: /Retry|Send quote|Preview/ })).toHaveCount(0);
	// The lock survives a reload (the panel reopens itself) and new correspondence.
	await conversation(context, { inbound: 'Did you send the quote?' });
	await page.goto(route);
	await expect(reconcile).toBeVisible();
	const unknown = status(page).getByTestId('financial-email-unknown');
	await expect(unknown).toContainText(
		/We can’t tell if the Quote email from .+ Pacific went out\./
	);
	await expect(unknown).toContainText('You can check it again in the email panel.');
	await expect(unknown).toContainText(/Send ID [0-9a-f-]{36}/);
	await expect(openEmail(page)).toHaveText('Review unresolved email');
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
	// A replay (200) closes the panel like an acceptance, with the replay copy.
	await expect(panel(page)).toHaveCount(0);
	await expect(page).toHaveURL(route);
	const notice = page.getByTestId('financial-email-accepted');
	await expect(notice).toHaveText(
		'This Quote email already went out earlier, so nothing new was sent. See it in Activity.'
	);
	await expect(notice).toBeFocused();
	await expect(status(page).getByTestId('financial-email-unknown')).toHaveCount(0);
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
	await expect(page.getByTestId('financial-email-error')).toHaveText(
		'We can’t tell if this email went out. Use Check again: it repeats the original send exactly and never sends a second copy.'
	);
	// An ambiguous outcome keeps the panel open.
	await expect(panel(page)).toBeVisible();
	await page.reload();
	const reconcile = page.getByRole('button', { name: 'Check again', exact: true });
	await expect(reconcile).toBeVisible();
	// The record was marked attempted before the lost call: the same opening line, then Check again.
	await expect(page.getByTestId('financial-email-locked')).toContainText(
		'We can’t tell if this email went out.'
	);
	await reconcile.click();
	await expect(page.getByTestId('financial-email-accepted')).toContainText(
		'already went out earlier, so nothing new was sent'
	);
	await expect(panel(page)).toHaveCount(0);
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
	await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
	await context.clearCookies({ name: /^fionas_fe/ });
	await page.goto(route);
	const lost =
		/^This browser doesn’t have the original email, so it can’t check it\. Don’t send a new one\. Ask an administrator to look into send ID [0-9a-f-]{36}\.$/;
	await expect(status(page).getByTestId('financial-email-lost')).toHaveText(lost);
	await expect(openEmail(page)).toHaveCount(0);
	await expect(panel(page).getByTestId('financial-email-lost')).toHaveText(lost);
	await expect(status(page).getByTestId('financial-email-unknown')).toContainText(
		'Only the original send can be checked. Don’t send another.'
	);
	await expect(page.getByRole('button', { name: /Preview|Send quote|Check again/ })).toHaveCount(0);
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
	await expect(error).toContainText('refused this email, so nothing went out');
	await expect(page.getByTestId('financial-email-rejected')).toBeVisible();
	await expect(panel(page)).toBeVisible();
	await page.goto(route);
	await expect(status(page).getByTestId('financial-email-rejected-status')).toHaveText(
		/^The last attempt \(.+ Pacific\) was refused by the email provider, so it wasn’t sent\.$/
	);
});

test('Invoice: SERVED with a balance offers Email invoice; other states never send', async ({
	page,
	context
}) => {
	await setup(page, context, served());
	await page.goto(route);
	await expect(status(page).getByTestId('financial-email-summary')).toHaveText(
		'This Invoice hasn’t been emailed. Marking it served didn’t send anything.'
	);
	await page.getByTestId('secondary-actions').getByRole('link', { name: 'Email invoice' }).click();
	await expect(panel(page).getByTestId('financial-email-intro')).toHaveText(
		'Sends the current Invoice and what’s still owed to Maya in this booking’s email thread, with their payment link. Nothing goes out until you press Send invoice.'
	);
	await page.getByRole('button', { name: 'Preview email', exact: true }).click();
	const review = panel(page).getByTestId('financial-email-review');
	await expect(review.getByTestId('email-required')).toHaveText('$415');
	await expect(review.getByTestId('email-balance')).toHaveText('$415');
	await expect(review.getByTestId('email-after-deposit')).toHaveCount(0);
	await page.getByRole('button', { name: 'Send invoice', exact: true }).click();
	await expect(panel(page)).toHaveCount(0);
	await expect(page.getByTestId('financial-email-accepted')).toContainText('Sent just now.');
	await expect(status(page).getByTestId('financial-email-summary')).toContainText(
		'This Invoice was emailed to Maya'
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
	await expect(status(page).getByTestId('financial-email-unavailable')).toHaveText(
		'It’s paid in full, so there’s nothing to collect by email.'
	);
	await expect(openEmail(page)).toHaveCount(0);
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
	const ask =
		'Ask an administrator to turn on emailing for you. It needs access to send email and to manage payment links.';
	await expect(status(page).getByTestId('financial-email-permissions')).toHaveText(ask);
	await expect(panel(page).getByTestId('financial-email-permissions')).toHaveText(ask);
	await expect(page.getByText(/payment-access|communications read/)).toHaveCount(0);
	await expect(openEmail(page)).toHaveCount(0);
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
		// The full-length toggle is CSS-driven, so it works without JavaScript too.
		const frameElement = page.getByTestId('email-preview-frame');
		expect((await frameElement.boundingBox())!.height).toBeCloseTo(720, 0);
		await page.getByText('Show the whole email').click();
		expect((await frameElement.boundingBox())!.height).toBeCloseTo(1800, 0);
		await expect(page.getByText('Shorter preview')).toBeVisible();
		await page.getByText('Show plain-text version').click();
		await expect(page.getByTestId('email-preview-text')).toBeVisible();
		await page.getByRole('button', { name: 'Send quote', exact: true }).click();
		// The redirect drops ?email: the panel is closed and the one-time notice is in Right now.
		await expect(page).toHaveURL(`${route}?from=filter%3Dquoted#financial-email-status`);
		await expect(panel(page)).toHaveCount(0);
		const notice = status(page).getByTestId('financial-email-accepted');
		await expect(notice).toHaveText(
			'Sent just now. See it in Activity; it shows as delivered once the email provider confirms.'
		);
		const messageId = await page
			.getByTestId('conversation')
			.locator('details:has([data-testid="financial-email-chip"])')
			.getAttribute('id');
		await expect(notice.getByRole('link', { name: 'See it in Activity' })).toHaveAttribute(
			'href',
			`#${messageId}`
		);
		await expect(status(page).getByTestId('financial-email-summary')).toContainText(
			'This Quote was emailed to Maya'
		);
		const state = await emails(context);
		expect(state.sends).toHaveLength(1);
		expect(state.sends[0].body.email.message).toBe(message);
		// The one-time notice is gone after another load.
		await page.reload();
		await expect(page.getByTestId('financial-email-accepted')).toHaveCount(0);
	});
});
