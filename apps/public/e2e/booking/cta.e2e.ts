import { expect, test } from '@playwright/test';
import { expectResponsiveHero } from '../hero-layout.js';

test('the enabled hero keeps copy beside the logo on desktop and below it on narrow viewports', async ({
	page
}) => {
	await expectResponsiveHero(page);
});

test('Book CTAs link to the form and the coming-soon badge is hidden', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByText('Booking late 2026')).toHaveCount(0);
	for (const name of ['Book', 'Book your scoops']) {
		await expect(page.getByRole('link', { name, exact: true })).toHaveAttribute('href', /\/book$/);
	}

	await page.getByRole('link', { name: 'Book your scoops' }).click();
	await expect(page).toHaveURL(/\/book$/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('bring fionas to your event');
});
