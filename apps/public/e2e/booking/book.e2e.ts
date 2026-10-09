import { expect, test } from '@playwright/test';
import { fillBasics, fillHandScooped, sendButton } from './form.js';
test('code-owned controls, minimum picks and unavailable presentation', async ({ page }) => {
	await page.goto('/book');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('bring fionas to your event');
	await expect(page.getByText(/scoop for/i)).toHaveCount(0);
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
test('guest stepper starts at 50, steps by 5, offers presets and refuses over 300', async ({
	page
}) => {
	await page.goto('/book');
	const guests = page.getByLabel('About how many guests?');
	await expect(guests).toHaveValue('50');
	await expect(page.getByText('Estimated total')).toBeVisible();
	await page.getByRole('button', { name: '5 more guests' }).click();
	await expect(guests).toHaveValue('55');
	await page.getByRole('button', { name: '5 fewer guests' }).click();
	await page.getByRole('button', { name: '5 fewer guests' }).click();
	await expect(guests).toHaveValue('45');
	await page.getByRole('button', { name: '200 guests' }).click();
	await expect(guests).toHaveValue('200');
	await expect(page.getByRole('button', { name: '200 guests' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await guests.press('Shift+ArrowUp');
	await expect(guests).toHaveValue('225');
	await guests.fill('301');
	await expect(guests).toHaveAccessibleDescription(/We quote up to 300 online/);
	await expect(page.getByRole('button', { name: '5 more guests' })).toBeDisabled();
	await sendButton(page).click();
	await expect(page.getByRole('alert').filter({ hasText: 'Please add:' })).toContainText(
		'an estimated guest count'
	);
	await guests.fill('300');
	await expect(guests).toHaveAccessibleDescription(/A best guess is fine/);
});
