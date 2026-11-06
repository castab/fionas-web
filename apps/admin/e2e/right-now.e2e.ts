import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { route, session, signIn, stubUrl } from './request-helpers.js';
import { paymentFixture } from './request-fixture.mjs';

/*
 * Right now holds one full-width primary action per stage; secondary actions sit below it side by
 * side (about 120px minimum each), wrapping only when there isn't room. Actions a staff member
 * can't take aren't shown, and the rest fill the row.
 */
const EMAIL = ['fionas.communications.send', 'fionas.payment-access.manage'];
const PAYMENT = 'commerce.payment.record';
const MANAGE = 'fionas.inquiries.manage';
const EDITOR = 'commerce.financial-document.create';

function quoted() {
	const request = paymentFixture('quoted');
	request.currentQuoteRevision = 2;
	request.proposal!.quoteRevision = 2;
	return request;
}
function booked() {
	const request = paymentFixture('booked');
	request.currentQuoteRevision = 2;
	request.acceptedQuoteRevision = 2;
	request.currentInvoiceRevision = 3;
	return request;
}
function served(balance: string) {
	const request = paymentFixture('served');
	request.currentQuoteRevision = 2;
	request.acceptedQuoteRevision = 2;
	request.currentInvoiceRevision = 3;
	request.financial.reconciliation.balance = balance;
	return request;
}

async function open(
	page: Page,
	context: BrowserContext,
	request: unknown,
	{ add = [] as string[], remove = [] as string[] } = {}
) {
	await signIn(page);
	const current = await session(context);
	await session(context, {
		request,
		permissions: [
			...current.permissions.filter((p: string) => !remove.includes(p) && !add.includes(p)),
			...add.filter((p) => !remove.includes(p))
		]
	});
	const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
	await context.request.post(`${stubUrl}/__test/conversation`, {
		headers: { cookie },
		data: { reset: true }
	});
	await page.goto(route);
	await expect(page.getByTestId('request-summary')).toBeVisible();
}

const primaryRow = (page: Page) => page.getByTestId('primary-actions');
const secondaryRow = (page: Page) => page.getByTestId('secondary-actions');
/** Button variants from the design-system recipe: secondary is outlined on a transparent fill. */
async function variant(button: Locator) {
	const classes = (await button.getAttribute('class')) ?? '';
	return classes.includes('bg-transparent') ? 'secondary' : 'primary';
}
const actions = (row: Locator) => row.locator('a[data-slot="button"], button[data-slot="button"]');

async function expectRow(
	row: Locator,
	labels: string[],
	kind: 'primary' | 'secondary'
): Promise<boolean> {
	await expect(actions(row)).toHaveText(labels.map((l) => new RegExp(`^\\s*${l}\\s*$`, 'i')));
	const buttons = await actions(row).all();
	for (const button of buttons) expect(await variant(button)).toBe(kind);
	const rowBox = (await row.boundingBox())!;
	const boxes = await Promise.all(buttons.map(async (b) => (await b.boundingBox())!));
	if (boxes.length === 1) {
		// A lone action fills its row.
		expect(Math.abs(boxes[0].width - rowBox.width)).toBeLessThan(2);
	} else {
		// Side by side, in order, each at least the ~120px minimum, while the labels fit; when they
		// don't (the 340px rail with "Record payment"), each wraps onto its own full-width line.
		const sideBySide = boxes.every((box) => Math.abs(box.y - boxes[0].y) < 2);
		if (!sideBySide) {
			// For the report: the row's width and each label's own (min-content) width.
			const needed = await Promise.all(buttons.map((b) => b.evaluate((el) => el.scrollWidth)));
			test.info().annotations.push({
				type: 'wrapped',
				description: `${labels.join(' + ')}: row ${Math.round(rowBox.width)}px, labels need ${needed.join(' + ')}px`
			});
		}
		for (const [i, box] of boxes.entries()) {
			expect(box.width).toBeGreaterThanOrEqual(119);
			if (i === 0) continue;
			if (sideBySide) expect(box.x).toBeGreaterThan(boxes[i - 1].x);
			else {
				expect(box.y).toBeGreaterThan(boxes[i - 1].y);
				expect(Math.abs(box.width - rowBox.width)).toBeLessThan(2);
			}
		}
		return sideBySide;
	}
	return true;
}

test('QUOTED: Record deposit leads; Revise quote and Email quote sit below it', async ({
	page,
	context
}) => {
	await open(page, context, quoted(), { add: EMAIL });
	await expectRow(primaryRow(page), ['Record deposit'], 'primary');
	expect(await expectRow(secondaryRow(page), ['Revise quote', 'Email quote'], 'secondary')).toBe(
		true
	);
	await expect(secondaryRow(page).getByTestId('open-financial-email')).toHaveAttribute(
		'href',
		`${route}?email`
	);
	// The Customer email block is status only.
	const status = page.getByTestId('financial-email-status');
	await expect(status).toContainText('This Quote hasn’t been emailed.');
	await expect(status.getByRole('link')).toHaveCount(0);
	await expect(status.getByRole('button')).toHaveCount(0);
	// The primary row comes first, then the secondary row.
	const [primaryBox, secondaryBox] = await Promise.all([
		primaryRow(page).boundingBox(),
		secondaryRow(page).boundingBox()
	]);
	expect(secondaryBox!.y).toBeGreaterThan(primaryBox!.y);
});

test('QUOTED without payment access: only the secondary row', async ({ page, context }) => {
	await open(page, context, quoted(), { add: EMAIL, remove: [PAYMENT] });
	await expect(primaryRow(page)).toHaveCount(0);
	expect(await expectRow(secondaryRow(page), ['Revise quote', 'Email quote'], 'secondary')).toBe(
		true
	);
});

test('QUOTED without email access: Revise quote fills the secondary row', async ({
	page,
	context
}) => {
	await open(page, context, quoted());
	await expectRow(primaryRow(page), ['Record deposit'], 'primary');
	await expectRow(secondaryRow(page), ['Revise quote'], 'secondary');
	await expect(page.getByTestId('financial-email-permissions')).toHaveText(
		'Ask an administrator to turn on emailing for you. It needs access to send email and to manage payment links.'
	);
});

test('QUOTED without editing access: Email quote fills the secondary row', async ({
	page,
	context
}) => {
	await open(page, context, quoted(), { add: EMAIL, remove: [EDITOR] });
	await expectRow(primaryRow(page), ['Record deposit'], 'primary');
	await expectRow(secondaryRow(page), ['Email quote'], 'secondary');
});

test('BOOKED: Mark event served leads, with its help; Record payment and Amend invoice below', async ({
	page,
	context
}) => {
	await open(page, context, booked(), { add: EMAIL });
	await expectRow(primaryRow(page), ['Mark event served'], 'primary');
	await expect(
		primaryRow(page).getByRole('button', { name: 'Mark event served' })
	).toHaveAccessibleDescription(/Mark the event served once it has been fulfilled/);
	await expectRow(secondaryRow(page), ['Record payment', 'Amend invoice'], 'secondary');
	// BOOKED never emails.
	await expect(page.getByTestId('open-financial-email')).toHaveCount(0);
});

test('BOOKED without fulfillment access: Record payment stays secondary', async ({
	page,
	context
}) => {
	await open(page, context, booked(), { remove: [MANAGE] });
	await expect(primaryRow(page)).toHaveCount(0);
	await expectRow(secondaryRow(page), ['Record payment', 'Amend invoice'], 'secondary');
});

test('SERVED and paid: Close event leads; Amend invoice fills the row; no email', async ({
	page,
	context
}) => {
	await open(page, context, served('0.00'), { add: EMAIL });
	await expectRow(primaryRow(page), ['Close event'], 'primary');
	await expectRow(secondaryRow(page), ['Amend invoice'], 'secondary');
	await expect(page.getByTestId('financial-email-unavailable')).toHaveText(
		'It’s paid in full, so there’s nothing to collect by email.'
	);
	await expect(page.getByTestId('open-financial-email')).toHaveCount(0);
});

test('SERVED with a balance: Record payment leads; Email invoice joins Amend invoice', async ({
	page,
	context
}) => {
	await open(page, context, served('415.00'), { add: EMAIL });
	await expect(page.getByRole('button', { name: 'Close event' })).toHaveCount(0);
	await expectRow(primaryRow(page), ['Record payment'], 'primary');
	await expectRow(secondaryRow(page), ['Amend invoice', 'Email invoice'], 'secondary');
	await expect(page.getByTestId('financial-email-summary')).toHaveText(
		'This Invoice hasn’t been emailed. Marking it served didn’t send anything.'
	);
});

// REQUESTED (Build quote beside Decline) is covered in request.e2e.ts.

test.describe('without JavaScript', () => {
	test.use({ javaScriptEnabled: false });

	test('the same rows render and Email quote is a plain link', async ({ page, context }) => {
		await open(page, context, quoted(), { add: EMAIL });
		await expectRow(primaryRow(page), ['Record deposit'], 'primary');
		expect(await expectRow(secondaryRow(page), ['Revise quote', 'Email quote'], 'secondary')).toBe(
			true
		);
		await page.getByTestId('open-financial-email').click();
		await expect(page).toHaveURL(`${route}?email`);
		await expect(page.getByTestId('financial-email-panel')).toBeVisible();
	});
});
