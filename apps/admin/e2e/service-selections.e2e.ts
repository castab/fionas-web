import { expect, test, type Locator, type Page } from '@playwright/test';
import {
	signIn,
	openMaya,
	openBuilder,
	waitForPreview,
	issueButton,
	session,
	route
} from './request-helpers.js';
import { mayaId } from './request-fixture.mjs';

/** Each category heading with its chips, in the order a reader meets them. */
async function groups(scope: Locator) {
	const result: [string, string[]][] = [];
	for (const list of await scope.getByRole('list').all()) {
		const name = await list.getAttribute('aria-labelledby');
		if (!name) continue;
		const heading = (await scope.locator(`[id="${name}"]`).textContent())?.trim() ?? '';
		result.push([
			heading,
			(await list.getByRole('listitem').allTextContents()).map((t) => t.trim())
		]);
	}
	return result;
}
/** The editor's groups, read from each row's label field. */
async function editorGroups(page: Page) {
	const result: [string, string[]][] = [];
	const scope = editor(page);
	for (const list of await scope.getByRole('list').all()) {
		const name = await list.getAttribute('aria-labelledby');
		const heading = (await scope.locator(`[id="${name}"]`).textContent())?.trim() ?? '';
		const labels = await list
			.locator('input[name^="selectionLabel:"]')
			.evaluateAll((inputs) => inputs.map((i) => (i as HTMLInputElement).value));
		result.push([heading, labels]);
	}
	return result;
}
async function noHorizontalOverflow(page: Page) {
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true
	);
}
const editor = (page: Page) => page.getByTestId('selection-editor');
const row = (page: Page, position: number) =>
	editor(page)
		.getByTestId('selection-row')
		.filter({
			has: page.getByLabel(`Selection ${position} label`, { exact: true })
		});
async function expand(page: Page, position: number) {
	const label = page.getByLabel(`Selection ${position} label`, { exact: true });
	if (!(await label.isVisible())) await row(page, position).locator('summary').click();
	await expect(label).toBeVisible();
}
/** Types a category and commits it (the change event), as leaving the field does. */
async function setCategory(page: Page, position: number, value: string) {
	const input = page.getByLabel(`Selection ${position} category`, { exact: true });
	await input.fill(value);
	await input.dispatchEvent('change');
}
const action = (page: Page, name: string, position: number) =>
	editor(page).getByRole('button', { name: new RegExp(`^${name} selection ${position},`) });

test('the original request shows the customer’s picks under their categories', async ({
	page
}, testInfo) => {
	await signIn(page);
	await openMaya(page);
	const picks = page.getByTestId('original-request');
	await expect(picks.getByRole('heading')).toHaveText([
		'What they asked for',
		'Soft serve',
		'Vessels',
		'Toppings',
		'Other selections',
		'Their notes'
	]);
	expect(await groups(picks)).toEqual([
		['Soft serve', ['Vanilla', 'Strawberry']],
		['Vessels', ['Waffle cones', 'Cups']],
		['Toppings', ['Rainbow sprinkles', 'Rainbow sprinkles']],
		['Other selections', ['Birthday candles']]
	]);
	await expect(picks).toContainText('My daughter loves strawberry!');
	await expect(page.getByTestId('event-card')).toContainText('40');
	await noHorizontalOverflow(page);
	await picks.screenshot({ path: testInfo.outputPath('original-selections.png') });
});

test.describe('native selections', () => {
	test.use({ javaScriptEnabled: false });
	test('edit, add, remove and reorder categorized commitments, then issue them', async ({
		page,
		context
	}, testInfo) => {
		await signIn(page);
		await openMaya(page);
		const original = (await session(context)).requests[mayaId].inquiry.requestedService;
		await openBuilder(page, true);
		// The draft starts as the customer's picks, categories, order and duplicates intact.
		expect(await editorGroups(page)).toEqual([
			['Soft serve', ['Vanilla', 'Strawberry']],
			['Vessels', ['Waffle cones', 'Cups']],
			['Toppings', ['Rainbow sprinkles', 'Rainbow sprinkles']],
			['Other selections', ['Birthday candles']]
		]);

		// Substitute the first pick under a new category.
		await expand(page, 1);
		await page.getByLabel('Selection 1 label', { exact: true }).fill('Birthday flavor');
		await setCategory(page, 1, 'Party specials');
		// Remove Strawberry, then add a custom selection under a new category.
		await action(page, 'Remove', 2).click();
		await editor(page).getByRole('button', { name: '+ Add selection', exact: true }).click();
		await expect(page.getByLabel('Selection 7 label', { exact: true })).toBeVisible();
		await page.getByLabel('Selection 7 label', { exact: true }).fill('Custom cups');
		await setCategory(page, 7, 'Supplies');
		// Move it above the uncategorized candles.
		await action(page, 'Move up', 7).click();
		await expect(row(page, 6)).toContainText('Custom cups');
		await page.getByRole('button', { name: 'Update preview', exact: true }).click();

		const proposed: [string, string[]][] = [
			['Party specials', ['Birthday flavor']],
			['Vessels', ['Waffle cones', 'Cups']],
			['Toppings', ['Rainbow sprinkles', 'Rainbow sprinkles']],
			['Supplies', ['Custom cups']],
			['Other selections', ['Birthday candles']]
		];
		expect(await groups(page.getByTestId('preview-service-plan'))).toEqual(proposed);
		const total = await page.getByTestId('quote-total').locator('dd').innerText();
		const deposit = await page.getByTestId('quote-deposit').locator('dd').innerText();
		await noHorizontalOverflow(page);
		await page.screenshot({ path: testInfo.outputPath('selection-editor.png'), fullPage: true });
		await page
			.getByTestId('quote-preview')
			.screenshot({ path: testInfo.outputPath('selection-preview.png') });

		await issueButton(page).click();
		await expect(page).toHaveURL(route);
		const state = await session(context);
		expect(state.proposalAttempts).toHaveLength(1);
		expect(state.proposalAttempts[0].body.servicePlan.items).toEqual([
			{ label: 'Birthday flavor', group: 'Party specials', key: null },
			{ label: 'Waffle cones', group: 'Vessels', key: 'waffle-cone' },
			{ label: 'Rainbow sprinkles', group: 'Toppings', key: 'rainbow-sprinkles' },
			{ label: 'Cups', group: 'Vessels', key: 'cup' },
			{ label: 'Rainbow sprinkles', group: 'Toppings', key: 'rainbow-sprinkles' },
			{ label: 'Custom cups', group: 'Supplies', key: null },
			{ label: 'Birthday candles', group: null, key: null }
		]);
		expect(state.requests[mayaId].inquiry.requestedService).toEqual(original);

		for (const reload of [false, true]) {
			if (reload) await page.reload();
			const plan = page.getByTestId('service-plan');
			expect(await groups(plan)).toEqual(proposed);
			await expect(plan).toContainText('Approved with Quote v2');
			// Money comes back from commerce, unchanged by any selection edit.
			await expect(page.getByTestId('financial-document')).toContainText(total);
			await expect(page.getByTestId('deposit-summary')).toContainText(deposit);
		}
		await noHorizontalOverflow(page);
		await page.screenshot({
			path: testInfo.outputPath('approved-selections.png'),
			fullPage: true
		});
	});
});

test('selections are chips: remove one, add others under categories, then issue them', async ({
	page,
	context
}, testInfo) => {
	await signIn(page);
	await openMaya(page);
	await openBuilder(page);
	expect(await editorGroups(page)).toEqual([
		['Soft serve', ['Vanilla', 'Strawberry']],
		['Vessels', ['Waffle cones', 'Cups']],
		['Toppings', ['Rainbow sprinkles', 'Rainbow sprinkles']],
		['Other selections', ['Birthday candles']]
	]);
	await expect(editor(page).getByTestId('selection-chip')).toHaveCount(7);
	await editor(page).getByRole('button', { name: 'Remove Vanilla', exact: true }).click();
	await waitForPreview(page);
	await editor(page).getByRole('button', { name: 'Remove Strawberry', exact: true }).click();
	await waitForPreview(page);
	await editor(page).getByRole('button', { name: '+ Add selection', exact: true }).click();
	const label = editor(page).getByLabel('Selection', { exact: true });
	const category = editor(page).getByLabel(/^Category/);
	const hint = editor(page).getByRole('status');
	// Enter adds the chip without submitting the quote form; the composer stays open.
	await label.fill('Birthday flavor');
	await category.fill('Party specials');
	await expect(hint).toHaveText('Creates a new category, “Party specials”.');
	await label.press('Enter');
	await expect(label).toHaveValue('');
	await label.fill('Custom cups');
	await category.fill('Supplies');
	await editor(page).getByRole('button', { name: 'Add', exact: true }).click();
	// A category typed in another case files under the existing one.
	await label.fill('Extra sprinkles');
	await category.fill('toppings');
	await expect(hint).toHaveText('Adds to Toppings.');
	await editor(page).getByRole('button', { name: 'Add', exact: true }).click();
	await category.fill('');
	await expect(hint).toHaveText('Leave the category blank to file it under Other selections.');
	await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
	// The dashed "+" at the end of a category swaps for a chip-shaped input in that category.
	const quick = editor(page).getByRole('button', { name: 'Add selection to Vessels', exact: true });
	await quick.click();
	const inline = editor(page).getByLabel('New selection in Vessels', { exact: true });
	await expect(inline).toBeFocused();
	await inline.fill('Gift tags');
	await inline.press('Escape');
	await expect(inline).toHaveCount(0);
	await expect(quick).toBeFocused();
	await quick.click();
	await inline.fill('Paper bowls');
	await inline.press('Enter');
	await expect(inline).toHaveValue('');
	await editor(page).screenshot({ path: testInfo.outputPath('selection-inline-add.png') });
	await inline.press('Escape');
	await waitForPreview(page);
	await editor(page).screenshot({ path: testInfo.outputPath('selection-chips.png') });

	const proposed: [string, string[]][] = [
		['Vessels', ['Waffle cones', 'Cups', 'Paper bowls']],
		['Toppings', ['Rainbow sprinkles', 'Rainbow sprinkles', 'Extra sprinkles']],
		['Party specials', ['Birthday flavor']],
		['Supplies', ['Custom cups']],
		['Other selections', ['Birthday candles']]
	];
	expect(await editorGroups(page)).toEqual(proposed);
	expect(await groups(page.getByTestId('preview-service-plan'))).toEqual(proposed);
	await noHorizontalOverflow(page);
	await issueButton(page).click();
	await expect(page).toHaveURL(route);
	const state = await session(context);
	expect(state.proposalAttempts).toHaveLength(1);
	expect(state.proposalAttempts[0].body.servicePlan.items).toEqual([
		{ label: 'Waffle cones', group: 'Vessels', key: 'waffle-cone' },
		{ label: 'Rainbow sprinkles', group: 'Toppings', key: 'rainbow-sprinkles' },
		{ label: 'Cups', group: 'Vessels', key: 'cup' },
		{ label: 'Rainbow sprinkles', group: 'Toppings', key: 'rainbow-sprinkles' },
		{ label: 'Birthday flavor', group: 'Party specials', key: null },
		{ label: 'Custom cups', group: 'Supplies', key: null },
		{ label: 'Birthday candles', group: null, key: null },
		{ label: 'Extra sprinkles', group: 'Toppings', key: null },
		{ label: 'Paper bowls', group: 'Vessels', key: null }
	]);
	expect(await groups(page.getByTestId('service-plan'))).toEqual(proposed);
});

for (const field of ['selectionGroup', 'selectionKey'])
	test(`a ${field} change that bypasses input handlers requires fresh review`, async ({
		page,
		context
	}) => {
		await signIn(page);
		await openMaya(page);
		await openBuilder(page);
		await page
			.locator(`[name^="${field}:"]`)
			.first()
			.evaluate((el: HTMLInputElement) => {
				el.value = 'Altered metadata';
			});
		await issueButton(page).click();
		await expect(page.getByText('The quote changed since you reviewed it')).toBeVisible();
		await waitForPreview(page);
		expect((await session(context)).proposalAttempts).toHaveLength(0);
		await issueButton(page).click();
		await expect(page).toHaveURL(route);
		expect(
			(await session(context)).proposalAttempts[0].body.servicePlan.items[0][
				field === 'selectionGroup' ? 'group' : 'key'
			]
		).toBe('Altered metadata');
	});

test.describe('native review', () => {
	test.use({ javaScriptEnabled: false });
	test('a native post with altered selections and an old fingerprint needs a new review', async ({
		page,
		context
	}) => {
		await signIn(page);
		await openMaya(page);
		await openBuilder(page, true);
		await page.getByRole('button', { name: 'Update preview', exact: true }).click();
		await expect(page.getByTestId('preview-service-plan')).toBeVisible();
		await expand(page, 1);
		await page.getByLabel('Selection 1 category', { exact: true }).fill('Changed after review');
		await issueButton(page).click();
		await expect(page.getByText('The quote changed since you reviewed it')).toBeVisible();
		expect((await session(context)).proposalAttempts).toHaveLength(0);
		expect(await groups(page.getByTestId('preview-service-plan'))).toContainEqual([
			'Changed after review',
			['Vanilla']
		]);
		await issueButton(page).click();
		await expect(page).toHaveURL(route);
		expect((await session(context)).proposalAttempts[0].body.servicePlan.items[0]).toEqual({
			label: 'Vanilla',
			group: 'Changed after review',
			key: 'vanilla'
		});
	});
});
