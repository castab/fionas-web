import { expect, test } from '@playwright/test';

test('the admin shell renders and stays out of search indexes', async ({ page }) => {
	await page.goto('/');

	await expect(page).toHaveTitle("Admin · Fiona's Ice Cream");
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Admin');
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
});
