import { expect, test } from '@playwright/test';
import { fillBasics, fillHandScooped } from './form.js';
test('code-owned controls, minimum picks and unavailable presentation', async ({ page }) => {
	await page.goto('/book');
	const soft = page.getByRole('group', { name: /Choose your soft serve/ });
	expect(await soft.getByRole('checkbox').count()).toBe(3);
	const hand = page.getByRole('group', { name: /Choose your hand-scooped/ });
	expect(await hand.getByRole('checkbox').count()).toBe(4);
	await expect(page.getByLabel('Tell us about your event')).toBeVisible();
	await expect(page.getByRole('checkbox', { name: 'gummy-bears' })).toBeDisabled();
	await fillBasics(page);
	await fillHandScooped(page);
	await expect(hand.getByRole('checkbox', { checked: true })).toHaveCount(4);
	await expect(page.getByText('Estimated total')).toBeVisible();
});
test('choice metadata uses explanatory popovers', async ({ page }) => {
	await page.goto('/book');
	await page.getByRole('button', { name: 'Crowd favorite', exact: true }).click();
	await expect(
		page.locator('[data-popover-content]').filter({ hasText: 'On the menu' })
	).toBeVisible();
});
