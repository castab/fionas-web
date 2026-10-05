import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mayaId, mayaDocumentId, requestFixtures } from './request-fixture.mjs';

const stubUrl = `http://127.0.0.1:${process.env.ADMIN_STUB_PORT ?? '4176'}`;
const route = `/requests/${mayaId}`;

async function session(context: BrowserContext, update?: unknown) {
	const cookie = (await context.cookies()).map(({ name, value }) => `${name}=${value}`).join('; ');
	const response =
		update === undefined
			? await context.request.get(`${stubUrl}/__test/request`, { headers: { cookie } })
			: await context.request.post(`${stubUrl}/__test/request`, {
					headers: { cookie },
					data: update
				});
	expect(response.ok()).toBe(true);
	return update === undefined ? response.json() : null;
}

async function signIn(page: Page, username = 'brayan') {
	await page.goto('/login');
	await page.getByLabel('User').fill(username);
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/$/);
}

async function openMaya(page: Page) {
	await page.getByTestId('request-card').filter({ hasText: 'Maya Torres' }).click();
	await expect(page).toHaveURL(route);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Maya Torres');
}

test.beforeEach(async ({ page }) => {
	await signIn(page);
});

test('dashboard navigation renders the original request, financial facts and current section', async ({
	page,
	context,
	isMobile
}, testInfo) => {
	if (!isMobile) await page.setViewportSize({ width: 1444, height: 1145 });
	const browserUrls: string[] = [];
	page.on('request', (request) => browserUrls.push(request.url()));
	const before = await session(context);
	const card = page.getByTestId('request-card').filter({ hasText: 'Maya Torres' });
	await card.focus();
	await card.press('Enter');
	await expect(page).toHaveURL(route);
	await expect(page.getByTestId('request-summary')).toContainText('Needs a quote');
	await expect(page.getByTestId('event-card')).toContainText('Saturday, July 25');
	await expect(page.getByTestId('event-card')).toContainText('Birthday party');
	await expect(page.getByTestId('event-card')).toContainText('40 guests');
	await expect(page.getByTestId('event-card')).toContainText('90 minutes');
	await expect(page.getByTestId('event-card')).toContainText('93720');
	await expect(page.getByText('Collected when booking', { exact: true })).toHaveCount(2);
	await expect(page.getByTestId('original-request')).toContainText('My daughter loves strawberry!');
	await expect(page.getByText('Recorded selection identifiers', { exact: false })).toBeHidden();
	await page.getByText('Original selection details', { exact: true }).click();
	await expect(page.getByText('Recorded selection identifiers', { exact: false })).toBeVisible();
	await expect(
		page.getByTestId('original-request').getByText('chocolate-chip', { exact: true })
	).toBeVisible();
	await page.getByText('Original selection details', { exact: true }).click();
	const financial = page.getByTestId('financial-document');
	await expect(financial).toContainText('Current estimate · Version 1 · USD');
	await expect(financial.getByRole('listitem')).toHaveText([
		/Base service.*\$205.*90 minutes.*Flat charge/s,
		/Ice cream service.*\$180.*40 × \$4.50/s,
		/Waffle cone upgrade.*\$30.*40 × \$0.75/s
	]);
	await expect(financial).toContainText('Subtotal');
	await expect(financial).toContainText('Tax');
	await expect(financial).toContainText('Current balance');
	await expect(financial).toContainText('$415');
	const navigation = page.getByRole('navigation', { name: 'Admin sections' });
	await expect(navigation.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute(
		'aria-current'
	);
	const requests = navigation.getByRole('button', { name: 'Requests Index coming next' });
	await expect(requests).toBeDisabled();
	await expect(requests).toHaveAttribute('aria-current', 'location');
	await expect(navigation.getByRole('link', { name: 'Requests' })).toHaveCount(0);
	await expect(page.getByLabel('Request lifecycle').locator('[aria-current="step"]')).toHaveText(
		'Requested'
	);
	const after = await session(context);
	expect(after.requestReads - before.requestReads).toBe(1);
	expect(after.readPaths.slice(before.readPaths.length)).toEqual([
		'/auth/me',
		`/staff/requests/${mayaId}`
	]);
	expect(browserUrls.some((url) => url.startsWith(stubUrl))).toBe(false);
	const response = await page.reload();
	expect(response?.headers()['cache-control']).toBe('no-store');
	await page.evaluate(() => document.fonts.ready);
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.locator('main').evaluate((element) => {
		element.scrollTop = 0;
	});
	await page.screenshot({ path: testInfo.outputPath('request-top.png'), fullPage: true });
	await financial.scrollIntoViewIfNeeded();
	await page.screenshot({
		path: testInfo.outputPath('request-financial.png'),
		fullPage: !isMobile
	});
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		)
	).toBeLessThanOrEqual(0);
});

test('issues the reviewed version, lands on a fresh Quote and never resubmits on refresh', async ({
	page,
	context
}) => {
	await openMaya(page);
	const browserUrls: string[] = [];
	page.on('request', (request) => browserUrls.push(request.url()));
	const before = await session(context);
	const response = page.waitForResponse(
		(response) => response.request().method() === 'POST' && response.url().includes('issueQuote')
	);
	await page.getByRole('button', { name: 'Issue quote', exact: true }).click();
	const actionResponse = await response;
	expect(await actionResponse.json()).toMatchObject({
		type: 'redirect',
		status: 303,
		location: route
	});
	await expect(page).toHaveURL(route);
	await expect(page.getByTestId('request-summary')).toContainText('Quote issued');
	await expect(page.getByTestId('request-summary')).not.toContainText('Needs a quote');
	await expect(page.getByTestId('financial-document')).toContainText('Current quote · Version 2');
	await expect(page.getByLabel('Request lifecycle').locator('[aria-current="step"]')).toHaveText(
		'Quoted'
	);
	await expect(page.getByRole('button', { name: 'Issue quote', exact: true })).toHaveCount(0);
	await expect(page.getByText(/Quote sent|Customer notified|Email delivered/)).toHaveCount(0);
	const after = await session(context);
	expect(after.quoteAttempts).toEqual([
		{ documentId: mayaDocumentId, body: { expectedVersion: 1 } }
	]);
	expect(after.requestReads - before.requestReads).toBe(2);
	expect(after.readPaths.slice(before.readPaths.length)).toEqual([
		'/auth/me',
		`/staff/requests/${mayaId}`,
		'/auth/me',
		`/staff/requests/${mayaId}`
	]);
	expect(browserUrls.some((url) => url.startsWith(stubUrl))).toBe(false);
	await page.reload();
	expect((await session(context)).quoteAttempts).toHaveLength(1);
	await page.getByRole('link', { name: 'Back to dashboard' }).click();
	await expect(page.getByTestId('request-card').filter({ hasText: 'Maya Torres' })).toHaveCount(0);
	await expect(page.getByTestId('summary-card').filter({ hasText: 'New' })).toHaveAttribute(
		'aria-label',
		'New: 1'
	);
	await expect(page.getByTestId('summary-card').filter({ hasText: 'Quoted' })).toHaveAttribute(
		'aria-label',
		'Quoted: 2'
	);
});

test('stale action read does not replace the reviewed version, and conflict requires explicit review', async ({
	page,
	context
}) => {
	await openMaya(page);
	const newer = requestFixtures()[mayaId];
	newer.financial.version = 2;
	await session(context, { request: newer });
	await page.getByRole('button', { name: 'Issue quote', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText(
		'This request changed since you opened it. Reload to review'
	);
	await expect(page.getByRole('button', { name: 'Issue quote', exact: true })).toBeDisabled();
	await expect(page.getByTestId('financial-document')).toContainText('Version 1');
	expect((await session(context)).quoteAttempts).toEqual([
		{ documentId: mayaDocumentId, body: { expectedVersion: 1 } }
	]);
	await expect(page.getByText('PRIVATE', { exact: false })).toHaveCount(0);
	await page.getByRole('link', { name: 'Reload to review' }).click();
	await expect(page.getByTestId('financial-document')).toContainText('Version 2');
	await expect(page.getByRole('button', { name: 'Issue quote', exact: true })).toBeEnabled();
	expect((await session(context)).quoteAttempts).toHaveLength(1);
});

for (const mode of [
	'quote-forbidden',
	'quote-not-found',
	'quote-conflict',
	'quote-unavailable',
	'quote-ambiguous'
]) {
	test(`${mode} requires reload/review without leaking private diagnostics or replaying`, async ({
		page,
		context
	}) => {
		await openMaya(page);
		await session(context, { mode });
		await page.getByRole('button', { name: 'Issue quote', exact: true }).click();
		await expect(page.getByRole('alert')).toBeVisible();
		await expect(page.getByText('PRIVATE', { exact: false })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Issue quote', exact: true })).toBeDisabled();
		expect((await session(context)).quoteAttempts).toHaveLength(1);
		if (mode === 'quote-unavailable' || mode === 'quote-ambiguous')
			await expect(page.getByRole('alert')).toContainText('couldn’t confirm whether');
		await page.getByRole('link', { name: 'Reload to review' }).click();
		if (mode === 'quote-ambiguous') {
			await expect(page.getByTestId('request-summary')).toContainText('Quote issued');
			await expect(page.getByRole('button', { name: 'Issue quote', exact: true })).toHaveCount(0);
		}
		expect((await session(context)).quoteAttempts).toHaveLength(1);
	});
}

test('same Administrator role without financial-create permission can read but sees no issuance action', async ({
	page,
	context
}) => {
	await context.clearCookies();
	await signIn(page, 'request-read-only');
	await openMaya(page);
	await expect(page.getByTestId('financial-document')).toContainText('Current estimate');
	await expect(page.getByRole('button', { name: 'Issue quote', exact: true })).toHaveCount(0);
	const state = await session(context);
	expect(state.permissions).not.toContain('commerce.financial-document.create');
	expect(state.quoteAttempts).toHaveLength(0);
});

for (const [mode, copy] of [
	['request-forbidden', 'This account cannot view this request.'],
	['request-not-found', 'This request could not be found.'],
	['request-unavailable', 'We couldn’t load this request. Try again shortly.'],
	['request-missing-reconciliation', 'We couldn’t load this request. Try again shortly.']
]) {
	test(`${mode} shows an intentional safe failure with back/retry navigation`, async ({
		page,
		context
	}) => {
		await session(context, { mode });
		await page.goto(route);
		await expect(page.getByRole('alert')).toContainText(copy);
		await expect(page.getByTestId('financial-document')).toHaveCount(0);
		await expect(page.getByText('PRIVATE', { exact: false })).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Back to dashboard' })).toBeVisible();
		if (mode === 'request-unavailable' || mode === 'request-missing-reconciliation') {
			await session(context, { mode: 'brayan' });
			await page.getByRole('link', { name: 'Try again' }).click();
			await expect(page.getByTestId('financial-document')).toBeVisible();
		}
	});
}

test('unknown request has a safe not-found state', async ({ page }) => {
	await page.goto('/requests/99999999-0000-0000-0000-000000000000');
	await expect(page.getByRole('alert')).toContainText('This request could not be found.');
});

test('long user text remains escaped and wraps; minimum guests and absent message remain distinct', async ({
	page,
	context
}) => {
	const request = requestFixtures()[mayaId];
	request.inquiry.email = `${'long'.repeat(45)}@example.com`;
	request.inquiry.message = `<script>window.BAD=true</script>\n${'long-note'.repeat(100)}`;
	request.inquiry.pricingInputs.guestCountIsMinimum = true;
	await session(context, { request });
	await page.goto(route);
	await expect(page.getByTestId('original-request')).toContainText(
		'<script>window.BAD=true</script>'
	);
	await expect(page.getByTestId('event-card')).toContainText('40+ guests (minimum)');
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		)
	).toBeLessThanOrEqual(0);
	delete request.inquiry.message;
	await session(context, { request });
	await page.reload();
	await expect(page.getByTestId('original-request')).toContainText('No additional message.');
});

test.describe('native forms', () => {
	test.use({ javaScriptEnabled: false });
	test('uses HTTP 303 and GET after issuance, and refresh cannot resubmit', async ({
		page,
		context
	}) => {
		await openMaya(page);
		const response = page.waitForResponse(
			(response) => response.request().method() === 'POST' && response.url().includes('issueQuote')
		);
		await page.getByRole('button', { name: 'Issue quote', exact: true }).click();
		expect((await response).status()).toBe(303);
		await expect(page).toHaveURL(route);
		await expect(page.getByTestId('request-summary')).toContainText('Quote issued');
		await expect(page.getByTestId('financial-document')).toContainText('Current quote · Version 2');
		await page.reload();
		expect((await session(context)).quoteAttempts).toHaveLength(1);
	});
	test('conflict remains blocked until an explicit GET review, even if the POST render reloads data', async ({
		page,
		context
	}) => {
		await openMaya(page);
		const request = requestFixtures()[mayaId];
		request.financial.version = 2;
		await session(context, { request });
		await page.getByRole('button', { name: 'Issue quote', exact: true }).click();
		await expect(page.getByRole('alert')).toContainText('Reload to review');
		await expect(page.getByRole('button', { name: 'Issue quote', exact: true })).toBeDisabled();
		await page.getByRole('link', { name: 'Reload to review' }).click();
		await expect(page).toHaveURL(route);
		await expect(page.getByRole('button', { name: 'Issue quote', exact: true })).toBeEnabled();
		expect((await session(context)).quoteAttempts).toHaveLength(1);
	});
});
