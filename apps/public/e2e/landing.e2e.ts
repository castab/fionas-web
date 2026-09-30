import { expect, test } from '@playwright/test';

test('the landing page renders the hero and brand chrome', async ({ page }) => {
	await page.goto('/');

	await expect(page).toHaveTitle("Fiona's Ice Cream");
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(
		'Classic hand-scooped ice cream and sweet treats!'
	);
	await expect(page.getByText('Booking late 2026')).toBeVisible();
	await expect(page.getByRole('img', { name: 'fionas ice cream' }).first()).toBeVisible();
	await expect(page.getByRole('link', { name: 'Follow on Instagram' })).toHaveAttribute(
		'href',
		'https://www.instagram.com/fionasicecream/'
	);

	const footer = page.getByRole('contentinfo');
	await expect(footer.getByRole('link', { name: '@fionasicecream', exact: true })).toBeVisible();
	await expect(footer.getByText('Fresno & Madera Ranchos')).toBeVisible();
	await expect(footer.getByRole('link', { name: 'contact@fionasicecream.com' })).toHaveAttribute(
		'href',
		'mailto:contact@fionasicecream.com'
	);
});

test('booking CTAs stay disabled and only raise the coming-soon toast', async ({ page }) => {
	await page.goto('/');

	for (const name of ['Book', 'Book the trailer']) {
		const cta = page.getByRole('button', { name, exact: true });
		await expect(cta).toHaveAttribute('aria-disabled', 'true');
		// aria-disabled makes Playwright treat the CTA as disabled; force the click like a visitor would.
		await cta.click({ force: true });

		const toast = page.getByRole('status');
		await expect(toast).toContainText('Booking opens soon');
		await expect(toast.getByRole('link', { name: 'Follow on Instagram' })).toHaveAttribute(
			'target',
			'_blank'
		);
		await expect(page).toHaveURL('/');

		await toast.getByRole('button', { name: 'Dismiss' }).click();
		await expect(toast).toHaveCount(0);
	}
});

test('the page fits its viewport without horizontal scrolling', async ({ page }) => {
	await page.goto('/');
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
		await page.evaluate(() => window.innerWidth)
	);
});

test('/book is a 404 while booking is gated', async ({ page, request }) => {
	const response = await page.goto('/book');
	expect(response?.status()).toBe(404);
	await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();

	// The form action and estimate endpoint are closed too, not just the page.
	expect((await request.post('/book/estimate', { data: {} })).status()).toBe(404);
});
