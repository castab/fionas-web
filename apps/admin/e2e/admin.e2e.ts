import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('User').fill('brayan');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/$/);
});

test('the dashboard greets the signed-in staff member and stays out of search indexes', async ({
	page
}) => {
	await expect(page).toHaveTitle("Dashboard · Admin · Fiona's Ice Cream");
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('hi, brayan');
	await expect(page.getByRole('heading', { name: 'waiting on you' })).toBeVisible();
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
});

test('blocks the API cannot power yet show placeholders, never sample data', async ({ page }) => {
	// Stat counts plus the three "waiting on you" groups.
	await expect(page.getByTestId('data-placeholder')).toHaveCount(4);
	for (const group of ['Needs a reply', 'Needs a quote', 'Needs resolution']) {
		await expect(page.getByRole('heading', { name: group })).toBeVisible();
	}
	// `?preview` fixtures exist only on the dev server.
	await page.goto('/?preview');
	await expect(page.getByText('Sample data')).toHaveCount(0);
	await expect(page.getByTestId('data-placeholder')).toHaveCount(4);
});

test('the shell shows a sidebar on desktop and a section nav on mobile', async ({
	page,
	isMobile
}) => {
	const nav = page.getByRole('navigation', { name: 'Admin sections' });
	await expect(nav).toHaveCount(1);
	await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
		'aria-current',
		'page'
	);
	for (const section of ['Requests', 'Calendar', 'Menu']) {
		await expect(nav.getByRole('button', { name: section })).toBeVisible();
	}
	if (isMobile) {
		await expect(page.getByTestId('sidebar')).toBeHidden();
		await page.getByLabel('Your account').click();
		await expect(page.getByTestId('account-menu')).toContainText('@brayan · Administrator');
	} else {
		await expect(page.getByTestId('sidebar')).toContainText('@brayan · Administrator');
		await expect(page.getByLabel('Your account')).toBeHidden();
	}
});
