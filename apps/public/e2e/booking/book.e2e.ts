import { expect, test } from '@playwright/test';
import { fillBasics, fillHandScooped, sendButton } from './form.js';
test('code-owned controls, minimum picks and unavailable presentation', async ({ page }) => {
	await page.goto('/book');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('book the trailer');
	const soft = page.getByRole('group', { name: /Soft serve — pick 2/ });
	expect(await soft.getByRole('checkbox').count()).toBe(3);
	const hand = page.getByRole('group', { name: /Hand-scooped — pick 4/ });
	expect(await hand.getByRole('checkbox').count()).toBe(4);
	await expect(page.getByLabel('Anything else?')).toBeVisible();
	await expect(page.getByRole('checkbox', { name: 'Gummy Bears' })).toBeDisabled();
	await fillBasics(page);
	await fillHandScooped(page);
	await expect(hand.getByRole('checkbox', { checked: true })).toHaveCount(4);
	await expect(page.getByText('Estimated total')).toBeVisible();
});
test('soft serve is a pick-two swirl', async ({ page }) => {
	await page.goto('/book');
	const soft = page.getByRole('group', { name: /Soft serve — pick 2/ });
	await expect(soft).toContainText('The third flavor is always a swirl of your two picks.');
	await soft.getByRole('checkbox', { name: 'Vanilla', exact: true }).check();
	await soft.getByRole('checkbox', { name: /^Horchata/ }).check();
	await expect(soft).toContainText('Your swirl: Vanilla + Horchata — the third handle comes free.');
	await expect(soft.getByText('2 of 2 picked')).toBeVisible();
	await expect(soft.getByRole('checkbox', { name: 'Chocolate', exact: true })).toBeDisabled();
});
test('choice metadata uses explanatory popovers', async ({ page }) => {
	await page.goto('/book');
	await page.getByRole('button', { name: 'Coming soon', exact: true }).click();
	await expect(
		page.locator('[data-popover-content]').filter({ hasText: 'Back on the menu soon!' })
	).toBeVisible();
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'More about Chocolate Chip' }).click();
	await expect(
		page.locator('[data-popover-content]').filter({ hasText: 'Contains milk' })
	).toBeVisible();
});
test('an incomplete send lists what to add and focuses the first gap', async ({ page }) => {
	await page.goto('/book');
	await sendButton(page).click();
	await expect(page.getByRole('alert').filter({ hasText: 'Please add:' })).toContainText(
		'Please add: your name, email, event ZIP code'
	);
	await expect(page.getByLabel('Your name')).toBeFocused();
});
