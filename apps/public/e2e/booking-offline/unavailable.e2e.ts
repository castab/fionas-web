import { expect, test } from '@playwright/test';

/*
 * This preview has booking on but its NATS_URL points at a port nothing listens on, so /book can't
 * publish. The customer gets the unavailable card instead of a form they'd fill in for nothing.
 */

test('/book offers no form while NATS is unreachable', async ({ page }) => {
	await page.goto('/book');
	await expect(
		page.getByRole('heading', { name: "The request form isn't available right now" })
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'Send booking request' })).toHaveCount(0);
	await expect(page.getByLabel('Your name')).toHaveCount(0);
});

test('the rest of the site still works', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});
