import { test, expect } from '@playwright/test';
test('an empty presentation gallery keeps the page available', async ({ page }) => {
	const response = await page.goto('/gallery');
	expect(response?.status()).toBe(200);
	await expect(
		page.getByText(
			'New photos and videos are on their way. Follow along on Instagram to see them first.'
		)
	).toBeVisible();
	await expect(
		page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Gallery' })
	).toHaveAttribute('aria-current', 'page');
	await expect(page.getByRole('button', { name: /View photo/ })).toHaveCount(0);
});
