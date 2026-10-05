import { expect, test, type BrowserContext } from '@playwright/test';

const stubUrl = `http://127.0.0.1:${process.env.ADMIN_STUB_PORT ?? '4176'}`;

// APIRequestContext does not apply the browser's localhost exception for Secure cookies over HTTP.
// Forward the test session explicitly to the test-only stub instrumentation.
async function stubSession(context: BrowserContext, mode?: string) {
	const cookie = (await context.cookies()).map(({ name, value }) => `${name}=${value}`).join('; ');
	const response =
		mode === undefined
			? await context.request.get(`${stubUrl}/__test/dashboard`, { headers: { cookie } })
			: await context.request.post(`${stubUrl}/__test/dashboard`, {
					headers: { cookie },
					data: { mode }
				});
	expect(response.ok()).toBe(true);
	return mode === undefined ? response.json() : null;
}

test.beforeEach(async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('User').fill('brayan');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/$/);
});

test('renders the operational projection with dates, amounts and snapshot waiting ages', async ({
	page,
	isMobile
}, testInfo) => {
	if (!isMobile) await page.setViewportSize({ width: 1779, height: 1170 });
	await expect(page).toHaveTitle("Dashboard · Admin · Fiona's Ice Cream");
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('hi, brayan');
	await expect(page.getByText('Thursday, July 16 · 5 requests waiting on you')).toBeVisible();
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
	const summary = page.getByTestId('summary-card');
	await expect(summary).toHaveCount(4);
	for (const [index, label] of ['New: 2', 'Quoted: 1', 'Booked: 1', 'Needs closing: 1'].entries()) {
		await expect(summary.nth(index)).toHaveAttribute('aria-label', label);
	}
	for (const group of ['Needs a reply', 'Needs a quote', 'Needs resolution']) {
		await expect(page.getByRole('heading', { name: group })).toBeVisible();
	}
	const cards = page.getByTestId('request-card');
	await expect(cards).toHaveCount(5);
	await expect(cards.filter({ hasText: 'Lena Ortiz' })).toContainText(
		'Waiting 2 days · School event'
	);
	await expect(cards.filter({ hasText: 'Lena Ortiz' })).toContainText('$560');
	await expect(cards.filter({ hasText: 'Marcus Lee' })).toContainText(
		'Waiting 1 day · Neighborhood event'
	);
	await expect(cards.filter({ hasText: 'Marcus Lee' })).toContainText('$550');
	await expect(cards.filter({ hasText: 'Dan Whitfield' })).toContainText('from $985');
	await expect(cards.filter({ hasText: 'Priya Nathan' })).toContainText('$492.50');
	await expect(cards.filter({ hasText: 'Priya Nathan' })).toContainText('Waiting 36 days');
	await expect(cards.filter({ hasText: 'Lena Ortiz' }).locator('time')).toHaveAttribute(
		'datetime',
		'2026-07-22'
	);
	await expect(cards.filter({ hasText: 'Lena Ortiz' }).locator('time')).toHaveText('Jul 22');
	await expect(cards.filter({ hasText: 'Dan Whitfield' }).locator('time')).toHaveText('Aug 8');
	await expect(cards.getByRole('button')).toHaveCount(0);
	for (const card of await cards.all()) {
		await expect(card).toHaveAttribute('href', /^\/requests\/[0-9a-f-]+$/);
		await expect(card).toHaveRole('link');
	}
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(0);
	// Preserve the rendered desktop/mobile layout for visual review, without the transient login toast.
	await page.reload();
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({ path: testInfo.outputPath('dashboard.png'), fullPage: true });
});

test('reads the dashboard exactly once per load, through the server, without per-inquiry reads', async ({
	page,
	context
}) => {
	const before = await stubSession(context);
	const browserUrls: string[] = [];
	page.on('request', (request) => browserUrls.push(request.url()));
	const response = await page.reload();
	await expect(page.getByTestId('request-card')).toHaveCount(5);
	const after = await stubSession(context);
	expect(after.dashboardReads - before.dashboardReads).toBe(1);
	expect(after.authReads - before.authReads).toBe(1);
	expect(after.readPaths.slice(before.readPaths.length)).toEqual(['/auth/me', '/staff/dashboard']);
	expect(browserUrls.some((url) => url.startsWith(stubUrl))).toBe(false);
	expect(browserUrls.some((url) => /\/(inquiries|financial-documents)\//.test(url))).toBe(false);
	expect(response?.headers()['cache-control']).toBe('no-store');
});

test('the shell has deliberate unavailable navigation and an accessible sign out', async ({
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
		await expect(nav.getByRole('button', { name: `${section} Coming next` })).toBeDisabled();
	}
	if (isMobile) {
		await expect(page.getByTestId('sidebar')).toBeHidden();
		await page.getByLabel('Your account').click();
		await expect(page.getByTestId('account-menu')).toContainText('@brayan · Administrator');
	} else {
		await expect(page.getByTestId('sidebar')).toContainText('@brayan · Administrator');
	}
	await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('overlapping queue membership counts each inquiry once and preserves both cards', async ({
	page,
	context
}) => {
	await stubSession(context, 'dashboard-overlap');
	await page.reload();
	await expect(page.getByText('Thursday, July 16 · 5 requests waiting on you')).toBeVisible();
	await expect(page.getByTestId('request-card').filter({ hasText: 'Maya Torres' })).toHaveCount(2);
	await expect(page.getByRole('region', { name: 'Needs a reply' })).toContainText(
		'Waiting less than a day'
	);
});

test('empty queues are a successful dashboard with intentional empty states', async ({
	page,
	context
}) => {
	await stubSession(context, 'dashboard-empty');
	await page.reload();
	await expect(page.getByText('0 requests waiting on you', { exact: false })).toBeVisible();
	await expect(page.getByText('You’re caught up here.')).toHaveCount(3);
	await expect(page.getByTestId('summary-card')).toHaveCount(4);
	await expect(page.getByTestId('request-card')).toHaveCount(0);
	await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const mode of ['dashboard-forbidden', 'dashboard-unavailable']) {
	test(`${mode} shows safe failure copy, no zero counts, and a working reload`, async ({
		page,
		context
	}) => {
		await stubSession(context, mode);
		await page.reload();
		const alert = page.getByRole('alert');
		await expect(alert).toContainText(
			mode === 'dashboard-forbidden'
				? 'This account cannot view the dashboard.'
				: 'We couldn’t load your dashboard.'
		);
		await expect(page.getByText('PRIVATE', { exact: false })).toHaveCount(0);
		await expect(page.getByTestId('summary-card')).toHaveCount(0);
		await expect(page.getByTestId('request-card')).toHaveCount(0);
		await stubSession(context, 'brayan');
		await page.getByRole('link', { name: 'Try again' }).click();
		await expect(page.getByTestId('request-card')).toHaveCount(5);
	});
}
