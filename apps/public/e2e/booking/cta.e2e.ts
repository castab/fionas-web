import { expect, test } from '@playwright/test';

test('Book CTAs link to the form and the coming-soon badge is hidden', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByText('Booking late 2026')).toHaveCount(0);
	for (const name of ['Book', 'Book the trailer']) {
		await expect(page.getByRole('link', { name, exact: true })).toHaveAttribute('href', /\/book$/);
	}

	await page.getByRole('link', { name: 'Book the trailer' }).click();
	await expect(page).toHaveURL(/\/book$/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('bring fionas to your event');
});
