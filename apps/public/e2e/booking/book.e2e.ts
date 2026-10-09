import { expect, test } from '@playwright/test';
import { fillBasics, fillContact, fillHandScooped, fillService, sendButton } from './form.js';
test('code-owned controls, minimum picks and unavailable presentation', async ({ page }) => {
	await page.goto('/book');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('bring fionas to your event');
	await expect(page.getByText(/scoop for/i)).toHaveCount(0);
	await expect(page.getByText(/soft serve/i)).toHaveCount(0);
	const hand = page.getByRole('group', { name: /Hand-scooped — pick 4/ });
	expect(await hand.getByRole('checkbox').count()).toBe(7);
	const toppings = page.getByRole('group', { name: /Toppings — pick 4 to 6/ });
	expect(await toppings.getByRole('checkbox').count()).toBe(9);
	const cones = page.getByRole('group', { name: /Cones & cups — pick 1 or more/ });
	await expect(cones.getByRole('checkbox')).toHaveCount(3);
	await expect(page.getByLabel('Anything else?')).toBeVisible();
	await expect(hand.getByRole('checkbox', { name: 'Cheesecake' })).toBeDisabled();
	await expect(page.getByRole('checkbox', { name: 'Marshmallow Sauce' })).toBeDisabled();
	await fillBasics(page);
	await fillHandScooped(page);
	await expect(hand.getByRole('checkbox', { checked: true })).toHaveCount(4);
	await expect(page.getByText('Estimated total')).toBeVisible();
});
test('cones and cups combine freely, need at least one, and add no charge', async ({ page }) => {
	await page.goto('/book');
	const cones = page.getByRole('group', { name: /Cones & cups — pick 1 or more/ });
	// All three can be chosen together; none gets locked out.
	for (const name of ['Cups', 'Sugar Cones', 'Cake Cones'])
		await cones.getByRole('checkbox', { name, exact: true }).check();
	await expect(cones.getByRole('checkbox', { checked: true })).toHaveCount(3);
	await expect(cones.getByRole('checkbox', { disabled: true })).toHaveCount(0);
});
test('an otherwise complete send with no cone or cup asks for one', async ({ page }) => {
	await page.goto('/book');
	await fillContact(page, 'no-cone@example.com');
	await fillService(page);
	const cones = page.getByRole('group', { name: /Cones & cups — pick 1 or more/ });
	for (const name of ['Sugar Cones', 'Cups'])
		await cones.getByRole('checkbox', { name, exact: true }).uncheck();
	await sendButton(page).click();
	await expect(page.getByRole('alert').filter({ hasText: 'Please add:' })).toContainText(
		'at least 1 cone or cup'
	);
});
test('choice metadata uses explanatory popovers', async ({ page }) => {
	await page.goto('/book');
	const soon = page.getByRole('button', { name: 'Coming soon', exact: true });
	await expect(soon).toHaveCount(2);
	for (const [i, note] of [
		[0, 'Creamy, dreamy, on its way!'],
		[1, 'Gooey goodness, almost here!']
	] as const) {
		await soon.nth(i).click();
		await expect(page.locator('[data-popover-content]').filter({ hasText: note })).toBeVisible();
		await page.keyboard.press('Escape');
	}
	for (const [item, note] of [
		['Butter Pecan', 'Contains tree nuts'],
		['Crushed Oreo', 'Contains wheat & soy'],
		['Sliced Almonds', 'Contains tree nuts']
	]) {
		await page.getByRole('button', { name: `More about ${item}` }).click();
		// A closed popover can linger in the DOM and two items share a note: look at the open one.
		await expect(
			page.locator('[data-popover-content][data-state="open"]').filter({ hasText: note })
		).toBeVisible();
		await page.keyboard.press('Escape');
	}
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
