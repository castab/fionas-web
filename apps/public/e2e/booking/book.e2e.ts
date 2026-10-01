import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { fillBasics, fillContact, fillService, submissionFor } from './form.js';

const estimatePanel = (page: Page) =>
	page.getByRole('heading', { name: /^Your estimate/ }).locator('../..');

test('the form is rendered from the inquiry-form definition', async ({ page }) => {
	await page.goto('/book');

	await expect(page).toHaveTitle(/^Book/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Book the trailer');
	for (const heading of [
		'Contact information',
		'Event details',
		'Build your ice cream service',
		'Additional information'
	]) {
		await expect(page.getByRole('heading', { name: heading })).toBeVisible();
	}

	// Short choice lists are chips, and nothing is hidden behind a toggle.
	await expect(page.getByRole('radio', { name: '120 minutes' })).toBeVisible();
	await expect(page.getByRole('checkbox', { name: 'sprinkles' })).toBeVisible();
	await expect(page.getByText('0 picked · 4 included, up to 6')).toBeVisible();

	// The service section may be skipped (a plain inquiry).
	await expect(
		page.locator('section', {
			has: page.getByRole('heading', { name: 'Build your ice cream service' })
		})
	).toContainText('Optional');
});

test('an unavailable option stays listed and readable but cannot be picked', async ({ page }) => {
	await page.goto('/book');

	const gummies = page.getByRole('checkbox', { name: /gummy-bears/ });
	await expect(gummies).toBeVisible();
	await expect(gummies).toBeDisabled();
	await expect(gummies).toHaveAccessibleName('gummy-bears · Unavailable — check back later');
	const chip = page.locator('[data-slot="choice-chip"]', { has: gummies });
	// Muted with a dashed outline, not faded out like a choice blocked by the maximum.
	await expect(chip).toHaveCSS('opacity', '1');
	await expect(chip).toHaveCSS('border-top-style', 'dashed');
	await gummies.click({ force: true });
	await expect(gummies).not.toBeChecked();
	await expect(page.getByRole('checkbox', { name: 'sprinkles' })).toBeEnabled();
});

test('blocks an empty submit and explains what is missing', async ({ page }) => {
	await page.goto('/book');
	await page.getByRole('button', { name: 'Send booking request' }).click();

	await expect(page.getByText('This field is required.').first()).toBeVisible();
	await expect(page.getByLabel('Your name')).toBeFocused();
	await expect(page).toHaveURL(/\/book$/);
});

test('checks the ZIP code format and the event date before sending', async ({ page }) => {
	await page.goto('/book');
	await page.getByLabel('ZIP code').fill('9372');
	await page.getByRole('button', { name: 'Send booking request' }).click();

	await expect(page.getByText('Enter 5 digits.')).toBeVisible();
	await expect(page.getByText('Pick a date.')).toBeVisible();
	await expect(page.getByText('Choose an option.').first()).toBeVisible();

	await page.getByLabel('ZIP code').fill('93720');
	await expect(page.getByText('Enter 5 digits.')).toHaveCount(0);
});

test('limits how many soft serve flavors can be picked', async ({ page }) => {
	await page.goto('/book');

	await page.getByRole('checkbox', { name: 'Vanilla' }).check();
	await page.getByRole('checkbox', { name: 'Horchata' }).check();
	await expect(page.getByText('2 picked · choose 1–2')).toBeVisible();
	await expect(page.getByRole('checkbox', { name: 'Chocolate' })).toBeDisabled();
	await page.getByRole('checkbox', { name: 'Horchata' }).uncheck();
	await expect(page.getByRole('checkbox', { name: 'Chocolate' })).toBeEnabled();
});

test('builds the estimate up as choices are made', async ({ page }) => {
	await page.goto('/book');
	const panel = estimatePanel(page);
	await expect(panel.getByText('Add your guest count and service length')).toBeVisible();

	// Guests + duration are enough for an estimate so far: $250 base + 75 x $4.
	await fillBasics(page);
	await expect(page.getByRole('heading', { name: 'Your estimate so far' })).toBeVisible();
	await expect(panel.getByText('$550', { exact: true })).toBeVisible();

	// Complete answers switch to the server's figures for the same choices.
	await fillService(page);
	await expect(page.getByRole('heading', { name: 'Your estimate', exact: true })).toBeVisible();
	await expect(panel.getByText('Base service')).toBeVisible();
	await expect(panel.getByText('Estimated total')).toBeVisible();
	await expect(panel.getByText('$643.75', { exact: true })).toBeVisible();
	await expect(panel.getByText('This is an early estimate, not a final quote.')).toBeVisible();
});

test('keeps the instant estimate when the estimate service is down', async ({ page }) => {
	await page.goto('/book');
	const answered = page.waitForResponse((r) => r.url().endsWith('/book/estimate'));
	// The stub answers 503 for 503 guests. Advisory math: 250 base + 503 * $4.00 service
	// + 503 * $0.50 Horchata + 503 * $0.75 waffle cones.
	await fillService(page, '503');
	expect((await answered).status()).toBe(503);

	const panel = estimatePanel(page);
	await expect(panel.getByText('$2,890.75', { exact: true })).toBeVisible();
	await expect(panel.getByText("couldn't update the estimate")).toHaveCount(0);
});

test('hides figures the server refuses to price', async ({ page }) => {
	await page.goto('/book');
	const answered = page.waitForResponse((r) => r.url().endsWith('/book/estimate'));
	await fillService(page, '422');
	expect((await answered).status()).toBe(422);

	const panel = estimatePanel(page);
	await expect(panel.getByText("couldn't price that combination")).toBeVisible();
	await expect(panel.getByText('Estimated total')).toHaveCount(0);
});

test('submits the request pinned to the catalog revision', async ({ page }) => {
	const email = `service-${randomUUID()}@example.com`;
	await page.goto('/book');
	await fillContact(page, email);
	await fillService(page);
	await page.getByLabel('Tell us about your event').fill('  Birthday party  ');
	await page.getByRole('button', { name: 'Send booking request' }).click();

	await expect(page.getByRole('status')).toContainText('we got your request');
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
		durationMinutes: 120
	});
	expect(submission?.pricingInputs?.selections).toEqual([
		{ category: 'soft-serve-flavor', offerings: ['vanilla', 'horchata'] },
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
