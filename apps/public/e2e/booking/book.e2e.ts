import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
	fillBasics,
	fillContact,
	fillHandScooped,
	fillService,
	sendButton,
	submissionFor
} from './form.js';

const estimatePanel = (page: Page) =>
	page.getByRole('heading', { name: /^Your estimate/ }).locator('../..');

test('the form is rendered from the inquiry-form definition', async ({ page }) => {
	await page.goto('/book');

	await expect(page).toHaveTitle(/^Request the trailer/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Request the trailer');
	// Sections in the backend's order, titled by the backend.
	await expect(page.locator('main form section h2')).toHaveText([
		'Contact information',
		'Event details',
		'Build your ice cream service',
		'Additional information'
	]);
	// Questions in the backend's order, labelled by the backend.
	await expect(
		page
			.getByRole('region', { name: 'Build your ice cream service' })
			.locator('[data-slot="field"]')
	).toContainText([
		'How many guests?',
		"How long are we scoopin'?",
		'Choose your soft serve flavors',
		'Choose your hand-scooped flavors',
		'Choose your toppings',
		'Choose your cones or cups'
	]);
	// Options in the backend's order.
	await expect(
		page
			.getByRole('group', { name: /Choose your soft serve flavors/ })
			.locator('[data-slot="choice-chip"]')
	).toHaveText([/Vanilla/, /Chocolate/, /Horchata/]);

	// Short choice lists are chips, and nothing is hidden behind a toggle.
	await expect(page.getByRole('radio', { name: '2 hours' })).toBeVisible();
	await expect(page.getByRole('checkbox', { name: 'sprinkles' })).toBeVisible();
	await expect(page.getByText('0 picked · 4 included, up to 6')).toBeVisible();

	// Definition version 11: the service section is required; only additional information isn't.
	await expect(
		page.getByRole('region', { name: 'Build your ice cream service' })
	).not.toContainText('Optional');
	await expect(page.getByRole('region', { name: 'Additional information' })).toContainText(
		'Optional'
	);
	await expect(page.getByRole('button', { name: /Clear these answers/ })).toHaveCount(0);
});

test('an unavailable option stays listed and readable but cannot be picked', async ({ page }) => {
	await page.goto('/book');

	const gummies = page.getByRole('checkbox', { name: /gummy-bears/ });
	await expect(gummies).toBeVisible();
	await expect(gummies).toBeDisabled();
	await expect(gummies).toHaveAccessibleName('gummy-bears');
	const chip = page.locator('[data-slot="choice-chip"]', { has: gummies });
	// Faded like the design's showcase chip (a choice blocked by the maximum fades to 0.45).
	await expect(chip).toHaveCSS('opacity', '0.55');
	await expect(chip).toHaveCSS('border-top-style', 'solid');
	await gummies.click({ force: true });
	await expect(gummies).not.toBeChecked();
	await expect(page.getByRole('checkbox', { name: 'sprinkles' })).toBeEnabled();
});

test('blocks an empty submit and explains what is missing', async ({ page }) => {
	await page.goto('/book');
	await sendButton(page).click();

	await expect(page.getByText('This field is required.').first()).toBeVisible();
	await expect(page.getByLabel('Your name')).toBeFocused();
	await expect(page).toHaveURL(/\/book$/);
});

test('checks the ZIP code format and the event date before sending', async ({ page }) => {
	await page.goto('/book');
	await page.getByLabel('ZIP code').fill('9372');
	await sendButton(page).click();

	await expect(page.getByText('Enter 5 digits.')).toBeVisible();
	await expect(page.getByText('Pick a date.')).toBeVisible();
	await expect(page.getByText('Choose an option.').first()).toBeVisible();

	await page.getByLabel('ZIP code').fill('93720');
	await expect(page.getByText('Enter 5 digits.')).toHaveCount(0);
});

test('limits how many soft serve flavors can be picked', async ({ page }) => {
	await page.goto('/book');

	await page.getByRole('checkbox', { name: 'Vanilla', exact: true }).check();
	await page.getByRole('checkbox', { name: 'Horchata' }).check();
	await expect(page.getByText('2 picked · choose 1–2')).toBeVisible();
	await expect(page.getByRole('checkbox', { name: 'Chocolate', exact: true })).toBeDisabled();
	await page.getByRole('checkbox', { name: 'Horchata' }).uncheck();
	await expect(page.getByRole('checkbox', { name: 'Chocolate', exact: true })).toBeEnabled();
});

test('requires four hand-scooped choices and stops a fifth pick', async ({ page }) => {
	await page.goto('/book');
	const group = page.getByRole('group', { name: /Choose your hand-scooped flavors/ });
	await expect(group.getByText('0 of 4 picked')).toBeVisible();
	await fillHandScooped(page);
	await expect(group.getByText('4 of 4 picked')).toBeVisible();
	await expect(group.getByRole('checkbox', { name: 'Hand-scooped Mint Chip' })).toBeDisabled();
	await group.getByRole('checkbox', { name: 'Hand-scooped Strawberry' }).uncheck();
	await expect(group.getByRole('checkbox', { name: 'Hand-scooped Mint Chip' })).toBeEnabled();
});

async function inspectChoiceDetails(page: Page, touch: boolean) {
	const group = page.getByRole('group', { name: /Choose your hand-scooped flavors/ });
	const returning = group.getByRole('checkbox', { name: /Hand-scooped New York Cheesecake/ });
	await expect(returning).toBeDisabled();
	await expect(returning).toHaveAccessibleDescription('Back on the menu this fall!');
	// Tapping anywhere on the faded chip opens its status bubble, not the (disabled) input.
	const status = page.locator('[data-slot="popover-content"]', {
		hasText: 'Back on the menu this fall!'
	});
	await expect(status).toBeHidden();
	const cheesecake = group.getByText('Hand-scooped New York Cheesecake', { exact: true });
	// force: Playwright treats text in a disabled input's label as disabled; the tap still lands on
	// the badge's pill-wide hit area, which is what this checks.
	if (touch) await cheesecake.tap({ force: true });
	else await cheesecake.click({ force: true });
	await expect(status).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(status).toBeHidden();

	const nuts = group.getByRole('checkbox', { name: /Hand-scooped Butter Pecan/ });
	const info = group.getByRole('button', { name: 'More about Hand-scooped Butter Pecan' });
	await expect(page.getByText('Contains tree nuts')).toBeHidden();
	if (touch) await info.tap();
	else {
		await info.focus();
		await page.keyboard.press('Enter');
	}
	await expect(page.getByText('Contains tree nuts')).toBeVisible();
	await expect(nuts).toBeDisabled();
	await expect(nuts).not.toBeChecked();
	await expect(returning).not.toBeChecked();
	await expect(group.getByText('0 of 4 picked')).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
		await page.evaluate(() => window.innerWidth)
	);
}

test('choice details work with keyboard and touch without selecting unavailable options', async ({
	page,
	isMobile
}) => {
	await page.goto('/book');
	await inspectChoiceDetails(page, isMobile);
});

test.describe('booking without JavaScript', () => {
	test.use({ javaScriptEnabled: false });
	test('shows choice badges and submits the complete service', async ({ page }) => {
		const email = `nojs-${randomUUID()}@example.com`;
		await page.goto('/book');
		// The status and info popovers need JavaScript; the badges still render.
		const group = page.getByRole('group', { name: /Choose your hand-scooped flavors/ });
		await expect(group.getByText('Returning soon')).toBeVisible();
		await fillContact(page, email);
		await fillService(page);
		await sendButton(page).click();
		await expect(page).toHaveURL(/\/book\/received$/);
		const submission = await submissionFor(page, email);
		expect(
			submission?.pricingInputs.selections.find((s) => s.category === 'hand-scooped-flavor')
				?.offerings
		).toHaveLength(4);
		expect(JSON.stringify(submission)).not.toMatch(/badge|statusNote|infoNote/);
	});
});

test('builds the estimate up as choices are made, entirely in the browser', async ({ page }) => {
	const previews: string[] = [];
	page.on('request', (r) => r.url().includes('/book/estimate') && previews.push(r.url()));
	await page.goto('/book');
	const panel = estimatePanel(page);
	await expect(panel.getByText('Add your guest count and service length')).toBeVisible();

	// Guests + duration are enough for an estimate so far: $250 base + 75 x $4. The base service is
	// described with the duration question's own label.
	await fillBasics(page);
	await expect(page.getByRole('heading', { name: 'Your estimate so far' })).toBeVisible();
	await expect(panel.getByText('$550', { exact: true })).toBeVisible();
	await expect(panel.getByText('2 hours', { exact: true })).toBeVisible();

	// Complete answers: 250 + 75 x ($4.00 service + $0.50 Horchata + $0.75 waffle cones).
	await fillService(page);
	await expect(page.getByRole('heading', { name: 'Your estimate', exact: true })).toBeVisible();
	await expect(panel.getByText('Base service', { exact: true })).toBeVisible();
	await expect(panel.getByText('Estimated total')).toBeVisible();
	await expect(panel.getByText('$643.75', { exact: true })).toBeVisible();
	await expect(panel.getByText('This is an early estimate, not a final quote.')).toBeVisible();
	// Display only: the backend prices the submission itself, so nothing asks it for a preview.
	expect(previews).toEqual([]);
});

test("shows the backend's own line wording when the form supplies it", async ({ page }) => {
	await page.goto('/book');
	await page.getByLabel('How many guests?').fill('75');
	// The fixture's 150-minute option carries its own base-service subtext.
	await page.getByRole('radio', { name: '2½ hours' }).check();
	const panel = estimatePanel(page);
	await expect(panel.getByText('2½ hours · setup, staff & local travel')).toBeVisible();
	await expect(panel.getByText('$575', { exact: true })).toBeVisible();
});

test('submits the request pinned to the catalog revision', async ({ page }) => {
	const email = `service-${randomUUID()}@example.com`;
	await page.goto('/book');
	await fillContact(page, email);
	await fillService(page);
	await page.getByLabel('Tell us about your event').fill('  Birthday party  ');
	await sendButton(page).click();

	await expect(page.getByRole('status')).toContainText('Request received');
	await expect.poll(() => submissionFor(page, email)).toBeTruthy();
	const submission = await submissionFor(page, email);
	expect(submission).toMatchObject({
		name: 'Jane Doe',
		email,
		message: 'Birthday party',
		// Sent as a string so the leading zero survives; the date is a plain calendar date.
		zipCode: '02134',
		eventDate: '2026-12-05',
		eventType: 'BIRTHDAY'
	});
	expect(submission?.pricingInputs).toMatchObject({
		catalogRevision: 15,
		guestCount: 75,
		guestCountIsMinimum: false,
		durationMinutes: 120
	});
	expect(submission?.pricingInputs?.selections).toEqual([
		{ category: 'soft-serve-flavor', offerings: ['vanilla', 'horchata'] },

		{
			category: 'hand-scooped-flavor',
			offerings: [
				'hand-scooped-chocolate-chip',
				'hand-scooped-chocolate',
				'hand-scooped-vanilla-bean',
				'hand-scooped-strawberry'
			]
		},
		{ category: 'topping', offerings: ['sprinkles', 'oreos', 'strawberries', 'brownies'] },
		{ category: 'cone-option', offerings: ['waffle-cone'] }
	]);
});

test('the form fits its viewport without horizontal scrolling', async ({ page }) => {
	await page.goto('/book');
	await fillService(page);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
		await page.evaluate(() => window.innerWidth)
	);
});
