import { expect, test, type Page } from '@playwright/test';

// Credentials understood by e2e/stub-commerce.mjs.
const username = 'brayan';
const password = 'e2e-password';

async function submit(page: Page, user: string, pass: string) {
	await page.getByLabel('User').fill(user);
	await page.getByLabel('Password').fill(pass);
	await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('signed out', () => {
	test('the sign-in page renders and stays out of search indexes', async ({ page }) => {
		await page.goto('/login');

		await expect(page).toHaveTitle("Sign in · Admin · Fiona's Ice Cream");
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('admin sign in');
		await expect(page.getByText('Booking requests, quotes & the calendar.')).toBeVisible();
		await expect(page.getByLabel('User')).toBeVisible();
		await expect(page.getByLabel('Password')).toHaveAttribute('type', 'password');
		await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
		await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
			'content',
			'noindex, nofollow'
		);
		// The prototype's demo credentials and the unsupported "Remember me" are not shipped.
		await expect(page.getByText('Prototype login')).toHaveCount(0);
		await expect(page.getByLabel('Remember me')).toHaveCount(0);
	});

	test('fits its viewport without horizontal scrolling', async ({ page }) => {
		await page.goto('/login');
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow).toBeLessThanOrEqual(0);
	});

	test('the sign-in section is centered vertically in the viewport', async ({ page }) => {
		await page.goto('/login');
		const logo = await page.getByRole('img', { name: 'fionas ice cream' }).boundingBox();
		const card = await page.locator('form').boundingBox();
		const viewport = page.viewportSize();
		if (!logo || !card || !viewport) throw new Error('sign-in section not rendered');

		// The logo and card together span from the logo's top to the card's bottom.
		const top = logo.y;
		const bottom = card.y + card.height;
		const above = top;
		const below = viewport.height - bottom;
		// Allow a few px of rounding; the section must not be pinned to the top.
		expect(Math.abs(above - below)).toBeLessThanOrEqual(2);
	});

	test('visiting a protected page redirects to sign in', async ({ page }) => {
		await page.goto('/');
		await expect(page).toHaveURL(/\/login$/);
	});

	test('wrong credentials show an inline error and an error toast, and set no session', async ({
		page,
		context
	}) => {
		await page.goto('/login');
		await submit(page, username, 'not-the-password');

		const message = 'That user and password don’t match — try again.';
		await expect(page).toHaveURL(/\/login$/);
		// Both the inline message and the toast carry the copy.
		await expect(page.getByRole('alert').filter({ hasText: message })).toHaveCount(2);
		await expect(page.getByLabel('User')).toHaveValue(username);
		expect(await context.cookies()).toEqual([]);
	});

	test('editing a field clears the inline error', async ({ page }) => {
		await page.goto('/login');
		await submit(page, username, 'nope');
		const inline = page.locator('form').getByRole('alert');
		await expect(inline).toBeVisible();

		await page.getByLabel('Password').fill('x');
		await expect(inline).toHaveCount(0);
	});

	test('missing fields explain what is needed', async ({ page }) => {
		await page.goto('/login');
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page.locator('form').getByRole('alert')).toHaveText(
			'Enter your user and password to sign in.'
		);
	});

	test('rate limiting tells the visitor how long to wait', async ({ page }) => {
		await page.goto('/login');
		await submit(page, 'ratelimited', 'whatever');
		await expect(page.locator('form').getByRole('alert')).toHaveText(
			'Too many attempts — try again in 5 minutes.'
		);
	});

	test('a backend failure never leaks its diagnostics', async ({ page }) => {
		await page.goto('/login');
		await submit(page, 'outage', 'whatever');
		const inline = page.locator('form').getByRole('alert');
		await expect(inline).toHaveText('Sign in is unavailable right now. Try again shortly.');
		await expect(page.getByText('could not be completed')).toHaveCount(0);
	});
});

test.describe('signing in and out', () => {
	test('valid credentials toast success, set an HttpOnly session cookie and land on the console', async ({
		page,
		context
	}) => {
		await page.goto('/login');
		await submit(page, username, password);

		await expect(page).toHaveURL(/\/$/);
		await expect(
			page.getByRole('status').filter({ hasText: 'Signed in — welcome back.' })
		).toBeVisible();
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Admin');

		const session = (await context.cookies()).find((c) => c.name === 'fionas_session');
		expect(session).toBeDefined();
		expect(session?.httpOnly).toBe(true);
		expect(session?.path).toBe('/');
		expect(session?.value).not.toBe('');
	});

	test('a signed-in visitor is sent away from the sign-in page', async ({ page }) => {
		await page.goto('/login');
		await submit(page, username, password);
		await expect(page).toHaveURL(/\/$/);

		await page.goto('/login');
		await expect(page).toHaveURL(/\/$/);
	});

	test('signing in works without JavaScript', async ({ browser }) => {
		const context = await browser.newContext({ javaScriptEnabled: false });
		const page = await context.newPage();
		await page.goto('/login');
		await submit(page, username, password);

		await expect(page).toHaveURL(/\/$/);
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Admin');
		await context.close();
	});

	test('signing out clears the session and guards the console again', async ({ page, context }) => {
		await page.goto('/login');
		await submit(page, username, password);
		await expect(page).toHaveURL(/\/$/);
		await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

		await page.getByRole('button', { name: 'Sign out' }).click();

		await expect(page).toHaveURL(/\/login$/);
		expect((await context.cookies()).find((c) => c.name === 'fionas_session')).toBeUndefined();
		await page.goto('/');
		await expect(page).toHaveURL(/\/login$/);
	});
});
