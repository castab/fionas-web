import { expect, test, type Page } from '@playwright/test';
import { mayaId } from './request-fixture.mjs';
import {
	issueButton,
	openBuilder,
	openMaya,
	previewThenIssue,
	route,
	session,
	signIn,
	waitForPreview
} from './request-helpers.js';

const total = (page: Page) => page.getByTestId('quote-total');

test.beforeEach(async ({ page }) => {
	await signIn(page);
	await openMaya(page);
});

test('negotiates a line and adds a discount, then shows why each Quote line exists', async ({
	page,
	context,
	isMobile
}, testInfo) => {
	await openBuilder(page);
	// Both actions stay side by side while the panel is open; Decline remains a disabled placeholder.
	await expect(page.getByTestId('build-quote')).toHaveAttribute('href', '#quote-builder');
	await expect(page.getByTestId('decline-request')).toBeDisabled();
	await expect(page.getByTestId('quote-basis')).toContainText(
		'Starts from their estimate’s lines and prices.'
	);
	await page.getByLabel('Amount for Ice cream service').fill('160');
	await expect(issueButton(page)).toBeDisabled();
	await expect(total(page)).toContainText('Changes not previewed yet');
	await page.getByLabel('Why the price of Ice cream service changed').fill('Package rate');
	await expect(total(page)).toContainText('$395');
	await expect(total(page)).toContainText('Their estimate was $415');
	await expect(page.getByTestId('quote-line').nth(1)).toContainText('Was $180 · 40 × $4.50');

	await page.getByRole('button', { name: '+ Add line' }).click();
	const added = page.getByTestId('quote-adjustment');
	await added.getByLabel('Added line name').fill('Courtesy discount');
	await added.getByRole('radio', { name: 'Discount' }).check();
	await added.getByLabel('Added line amount').fill('20');
	await added.getByLabel('Why this line is added').fill('Customer accommodation');
	await expect(total(page)).toContainText('$375');
	await expect(added).toContainText('-$20');
	await expect(page.getByTestId('quote-deposit')).toContainText('$75');
	if (!isMobile) await page.setViewportSize({ width: 1280, height: 2000 });
	await page.getByTestId('quote-builder').screenshot({ path: testInfo.outputPath('builder.png') });
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		)
	).toBeLessThanOrEqual(0);

	await issueButton(page).click();
	await expect(page).toHaveURL(route);
	await expect(page.getByTestId('request-summary')).toContainText('Quote issued');
	const financial = page.getByTestId('financial-document');
	await expect(financial).toContainText('Current quote · Version 3');
	await expect(financial).toContainText('Negotiated · Package rate');
	await expect(financial).toContainText('Discount · Customer accommodation');
	await expect(page.getByTestId('deposit-summary')).toContainText('$75');
	const [attempt] = (await session(context)).proposalAttempts;
	expect(attempt.body.composition).toEqual({
		pricing: { mode: 'KEEP_ESTIMATE' },
		overrides: [
			{
				target: { type: 'EXISTING_LINE', lineItemId: '20000000-0000-0000-0000-000000000002' },
				finalAmount: '160',
				currency: 'USD',
				reason: 'Package rate'
			}
		],
		adjustments: [
			{
				clientKey: expect.stringMatching(/^line-/),
				kind: 'DISCOUNT',
				description: 'Courtesy discount',
				amount: '20',
				currency: 'USD',
				reason: 'Customer accommodation'
			}
		]
	});
});

test('a priced pick swap is recalculated from today’s catalog and saved as the plan', async ({
	page,
	context
}) => {
	await openBuilder(page);
	await page.getByRole('button', { name: 'Remove Waffle cones' }).click();
	await page.getByRole('button', { name: 'Add to Cones & cups' }).click();
	await page.getByRole('button', { name: 'Cups & cake cones' }).click();
	await expect(
		page.getByText('Changed from their estimate — added Cups & cake cones · removed Waffle cones.')
	).toBeVisible();
	await expect(page.getByTestId('quote-basis')).toContainText('recalculated from today’s catalog');
	await expect(page.getByText('Those pick changes affect the price')).toBeVisible();
	await expect(total(page)).toContainText('$385');
	await waitForPreview(page);
	await issueButton(page).click();
	await expect(page.getByTestId('request-summary')).toContainText('Quote issued');
	await expect(page.getByTestId('service-plan')).toContainText('Cups & cake cones');
	await expect(page.getByTestId('service-plan')).not.toContainText('Waffle cones');
	const state = await session(context);
	expect(state.proposalAttempts.at(-1).body.composition.pricing).toMatchObject({
		mode: 'REPRICE_CONFIGURATION',
		catalogRevision: 15,
		guestCount: 40,
		durationMinutes: 90
	});
	// Each preview tried a revision first; previews write nothing.
	expect(
		state.previewAttempts.some(
			(attempt: { body: { composition: { pricing: { mode: string } } } }) =>
				attempt.body.composition.pricing.mode === 'REVISE_SERVICE_SELECTIONS'
		)
	).toBe(true);
});

test('an unpriced pick swap keeps the estimate’s prices', async ({ page, context }) => {
	await openBuilder(page);
	await page.getByRole('button', { name: 'Remove Brownies' }).click();
	await page.getByRole('button', { name: 'Add to Toppings' }).click();
	await expect(page.getByRole('button', { name: 'Gummy bears' })).toBeDisabled();
	await page.getByRole('button', { name: 'Hot fudge' }).click();
	await expect(page.getByTestId('quote-basis')).toContainText('prices stay the same');
	await expect(total(page)).toContainText('$415');
	await previewThenIssue(page);
	await expect(page.getByTestId('service-plan')).toContainText('Hot fudge');
	expect((await session(context)).proposalAttempts[0].body.composition.pricing.mode).toBe(
		'REVISE_SERVICE_SELECTIONS'
	);
});

test('full lists offer no add, and unavailable or disabled offerings cannot be picked', async ({
	page
}) => {
	await openBuilder(page);
	await expect(page.getByRole('button', { name: 'Add to Hand-scooped' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Remove Mint Chip' }).click();
	await page.getByRole('button', { name: 'Add to Hand-scooped' }).click();
	await expect(page.getByRole('button', { name: /Butter Pecan/ })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Rocky Road' })).toHaveCount(0);
	await expect(page.getByText('One list needs more picks.')).toBeVisible();
	await expect(issueButton(page)).toBeDisabled();
});

test('changing guests reprices, and source overrides follow the recalculated lines', async ({
	page,
	context
}) => {
	await openBuilder(page);
	await page.getByLabel('Guests', { exact: true }).fill('50');
	await expect(total(page)).toContainText('$467.50');
	await expect(page.getByTestId('quote-basis')).toContainText('recalculated');
	await page.getByLabel('Amount for Base service').fill('200');
	await page.getByLabel('Why the price of Base service changed').fill('Neighbor rate');
	await expect(total(page)).toContainText('$462.50');
	await previewThenIssue(page);
	await expect(page.getByTestId('financial-document')).toContainText('Negotiated · Neighbor rate');
	const composition = (await session(context)).proposalAttempts[0].body.composition;
	expect(composition.pricing).toMatchObject({ mode: 'REPRICE_CONFIGURATION', guestCount: 50 });
	expect(composition.overrides).toEqual([
		{
			target: { type: 'BASE_SERVICE' },
			finalAmount: '200',
			currency: 'USD',
			reason: 'Neighbor rate'
		}
	]);
});

test('a stale review shows the new preview and issues only on another explicit click', async ({
	page,
	context
}) => {
	await openBuilder(page);
	await session(context, { mode: 'quote-review-stale' });
	await issueButton(page).click();
	await expect(page.getByText('The quote changed since you reviewed it')).toBeVisible();
	expect((await session(context)).proposalAttempts).toHaveLength(1);
	await expect(issueButton(page)).toBeEnabled();
	await issueButton(page).click();
	await expect(page.getByTestId('request-summary')).toContainText('Quote issued');
	expect((await session(context)).proposalAttempts).toHaveLength(2);
});

test('a failed preview can be retried and never enables issue on its own', async ({
	page,
	context
}) => {
	await session(context, { mode: 'preview-unavailable' });
	await page.getByTestId('build-quote').click();
	await expect(page.getByRole('alert').first()).toContainText(
		'We couldn’t preview this quote just now'
	);
	await expect(issueButton(page)).toBeDisabled();
	await expect(page.getByText('PRIVATE', { exact: false })).toHaveCount(0);
	await session(context, { mode: 'brayan' });
	await page.getByRole('button', { name: 'Preview again' }).click();
	await waitForPreview(page);
	await expect(issueButton(page)).toBeEnabled();
	expect((await session(context)).proposalAttempts).toHaveLength(0);
});

test('a catalog change mid-review reloads the menu and asks for another preview', async ({
	page,
	context
}) => {
	await openBuilder(page);
	await session(context, { catalogRevision: 16 });
	await page.getByLabel('Guests', { exact: true }).fill('45');
	await expect(page.getByRole('alert').first()).toContainText('The menu changed');
	await expect(issueButton(page)).toBeDisabled();
	await page.getByRole('button', { name: 'Preview again' }).click();
	await expect(total(page)).toContainText('$441.25');
	await expect(issueButton(page)).toBeEnabled();
	const attempts = (await session(context)).previewAttempts;
	expect(attempts.at(-1).body.composition.pricing.catalogRevision).toBe(16);
});

test('without the menu, the service is read-only and the Estimate can still be issued', async ({
	page,
	context
}) => {
	await session(context, { mode: 'catalog-unavailable' });
	await openBuilder(page);
	await expect(page.getByText('The menu couldn’t be loaded')).toBeVisible();
	await expect(page.getByLabel('Guests', { exact: true })).toHaveCount(0);
	await previewThenIssue(page);
	await expect(page.getByTestId('request-summary')).toContainText('Quote issued');
	expect((await session(context)).proposalAttempts[0].body.composition).toEqual({
		pricing: { mode: 'KEEP_ESTIMATE' }
	});
});

test.describe('without JavaScript', () => {
	test.use({ javaScriptEnabled: false });
	test('picks are checkbox chips and the blank added line can be filled, previewed and issued', async ({
		page,
		context
	}) => {
		await openBuilder(page, true);
		await expect(page.getByRole('checkbox', { name: 'Waffle cones' })).toBeChecked();
		await expect(page.getByRole('checkbox', { name: /Gummy bears/ })).toBeDisabled();
		const added = page.getByTestId('quote-adjustment');
		await expect(added).toHaveCount(1);
		await added.getByLabel('Added line name').fill('Additional travel fee');
		await added.getByLabel('Added line amount').fill('25');
		await added.getByLabel('Why this line is added').fill('Outside normal service area');
		await page.getByRole('button', { name: 'Update preview', exact: true }).click();
		await expect(total(page)).toContainText('$440');
		await expect(page.getByTestId('quote-adjustment')).toHaveCount(2);
		await issueButton(page).click();
		await expect(page.getByTestId('request-summary')).toContainText('Quote issued');
		await expect(page.getByTestId('financial-document')).toContainText(
			'Charge · Outside normal service area'
		);
		const [attempt] = (await session(context)).proposalAttempts;
		expect(attempt.inquiryId).toBe(mayaId);
		expect(attempt.body.composition.adjustments).toEqual([
			{
				clientKey: 'line-1',
				kind: 'CHARGE',
				description: 'Additional travel fee',
				amount: '25',
				currency: 'USD',
				reason: 'Outside normal service area'
			}
		]);
	});
});
