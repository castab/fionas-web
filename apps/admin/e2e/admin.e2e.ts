import { expect, test } from '@playwright/test';

test('the admin shell renders once signed in and stays out of search indexes', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('User').fill('brayan');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in' }).click();

	await expect(page).toHaveURL(/\/$/);
	await expect(page).toHaveTitle("Admin · Fiona's Ice Cream");
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Admin');
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
});
