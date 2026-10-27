import { expect, test, type Locator, type Page } from '@playwright/test';
import { mayaId, sofiaId } from './request-fixture.mjs';
import {
	issueButton,
	previewThenIssue,
	session,
	signIn,
	stubUrl,
	waitForPreview
} from './request-helpers.js';

const lenaId = '00000000-0000-0000-0000-000000000001';
const hannahId = '00000000-0000-0000-0000-000000000008';
const rows = (page: Page) => page.getByTestId('request-row');
const names = (page: Page) => page.getByTestId('request-row-name');
const filters = (page: Page) => page.getByRole('navigation', { name: 'Request filters' });
const searchBox = (page: Page) => page.getByRole('searchbox', { name: 'Search requests' });
const count = (page: Page) => page.getByTestId('request-count');
const back = (page: Page) => page.getByTestId('workspace-back');
const row = (page: Page, name: string) => rows(page).filter({ hasText: name });

async function search(page: Page, text: string) {
	await searchBox(page).fill(text);
	await page.getByRole('button', { name: 'Search', exact: true }).click();
}
async function noOverflow(page: Page) {
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		)
	).toBeLessThanOrEqual(0);
}
/** Where a link leads, resolved; server-rendered hrefs may be relative without JavaScript. */
const destination = (link: Locator) =>
	link.evaluate((a) => {
		const url = new URL((a as HTMLAnchorElement).href);
		return url.pathname + url.search;
	});
/** The return parameter a workspace link carries for this list query. */
const from = (query: string) => `from=${encodeURIComponent(query)}`;

// Backend order: inquiry creation descending, then inquiry UUID descending.
const everyone = [
	'Maya Torres',
	'Sofia Ramirez-Delacruz',
	'Hannah Kim',
	'Priya Nathan',
	'Dan Whitfield',
	'Marcus Lee',
	'Lena Ortiz',
	'Oliver Grant'
];

test.beforeEach(async ({ page }) => {
	await signIn(page);
});

test('dashboard tiles are keyboard links to their filtered Requests views, with queues unchanged', async ({
	page
}) => {
	const tiles = page.getByTestId('summary-card');
	await expect(tiles).toHaveCount(4);
	await expect(page.getByTestId('request-card')).toHaveCount(5);
	for (const [label, filter, title] of [
		['New', 'new', 'New'],
		['Quoted', 'quoted', 'Quoted'],
		['Booked', 'booked', 'Booked'],
		['Needs closing', 'needs-closing', 'Needs closing']
	]) {
		await page.goto('/');
		const tile = tiles.filter({ hasText: label });
		await tile.focus();
		await expect(tile).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(`/requests?filter=${filter}`);
		await expect(filters(page).getByRole('link', { name: title, exact: true })).toHaveAttribute(
			'aria-current',
			'page'
		);
	}
	// The queues still open request workspaces directly.
	await page.goto('/');
	await page.getByTestId('request-card').filter({ hasText: 'Maya Torres' }).click();
	await expect(page).toHaveURL(`/requests/${mayaId}`);
	await expect(back(page)).toHaveText('← Back to dashboard');
	await back(page).click();
	await expect(page).toHaveURL('/');
});

test('a zero-count tile still opens its empty Requests view', async ({ page, context }) => {
	await session(context, { mode: 'dashboard-empty', listMode: 'list-empty' });
	await page.reload();
	const tile = page.getByTestId('summary-card').filter({ hasText: 'Needs closing' });
	await expect(tile).toHaveAttribute(
		'aria-label',
		'Needs closing: 0. View requests that need closing'
	);
	await tile.click();
	await expect(page).toHaveURL('/requests?filter=needs-closing');
	await expect(page.getByTestId('request-list-empty')).toContainText('No requests need closing.');
	await expect(page.getByRole('alert')).toHaveCount(0);
	await page.getByRole('link', { name: 'View all requests' }).click();
	await expect(page).toHaveURL('/requests');
	await expect(page.getByTestId('request-list-empty')).toContainText(
		'No requests yet. New inquiries will appear here.'
	);
	await expect(page.getByTestId('request-list-empty').getByRole('link')).toHaveCount(0);
});

test('Requests is enabled in the shell and current on the index and every workspace', async ({
	page,
	isMobile
}) => {
	const nav = page.getByRole('navigation', { name: 'Admin sections' });
	await expect(page.getByTestId('sidebar')).toBeVisible({ visible: !isMobile });
	await nav.getByRole('link', { name: 'Requests' }).click();
	await expect(page).toHaveURL('/requests');
	await expect(page).toHaveTitle("Requests · Admin · Fiona's Ice Cream");
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Requests');
	await expect(nav.getByRole('link', { name: 'Requests' })).toHaveAttribute('aria-current', 'page');
	await expect(nav.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
	for (const section of ['Calendar', 'Menu'])
		await expect(nav.getByRole('button', { name: `${section} Coming next` })).toBeDisabled();
	await expect(page.getByText('Index coming next')).toHaveCount(0);
	await row(page, 'Sofia').click();
	await expect(page).toHaveURL(new RegExp(`/requests/${sofiaId}\\?`));
	await expect(nav.getByRole('link', { name: 'Requests' })).toHaveAttribute(
		'aria-current',
		'location'
	);
	await expect(nav.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
	await page.goto('/requests?filter=quoted');
	await expect(filters(page).getByRole('link', { name: 'Quoted' })).toHaveAttribute(
		'aria-current',
		'page'
	);
	await expect(names(page)).toHaveText(['Sofia Ramirez-Delacruz', 'Lena Ortiz']);
});

test('all seven filters show the backend membership, order and actual stages', async ({ page }) => {
	await page.goto('/requests');
	const expected: [string, string, string[], string][] = [
		['All requests', '/requests', everyone, '8 requests'],
		['New', '/requests?filter=new', ['Maya Torres', 'Dan Whitfield'], '2 requests'],
		['Quoted', '/requests?filter=quoted', ['Sofia Ramirez-Delacruz', 'Lena Ortiz'], '2 requests'],
		['Booked', '/requests?filter=booked', ['Priya Nathan', 'Oliver Grant'], '2 requests'],
		['Needs closing', '/requests?filter=needs-closing', ['Priya Nathan'], '1 request'],
		['Closed', '/requests?filter=closed', ['Marcus Lee'], '1 request'],
		['Declined', '/requests?filter=declined', ['Hannah Kim'], '1 request']
	];
	for (const [label, url, people, total] of expected) {
		await filters(page).getByRole('link', { name: label, exact: true }).click();
		await expect(page).toHaveURL(url);
		await expect(filters(page).locator('[aria-current="page"]')).toHaveText(label);
		await expect(names(page)).toHaveText(people);
		await expect(count(page)).toHaveText(total);
	}
	// Booked shows each request's own stage: Priya was served and is ready to close.
	await filters(page).getByRole('link', { name: 'Booked' }).click();
	await expect(row(page, 'Priya').getByTestId('request-row-stage')).toHaveText('Served');
	await expect(row(page, 'Priya').getByTestId('request-row-needs-closing')).toHaveText(
		'Needs closing'
	);
	await expect(row(page, 'Oliver').getByTestId('request-row-stage')).toHaveText('Booked');
	await expect(row(page, 'Oliver').getByTestId('request-row-needs-closing')).toHaveCount(0);
	await expect(row(page, 'Oliver')).toContainText('Sat, Aug 22, 2026 · Corporate event');
	await expect(row(page, 'Oliver').getByTestId('request-row-amount')).toHaveText(
		/Invoice\s*\$720\s*Balance \$576/
	);
	await page.goto('/requests');
	await expect(row(page, 'Dan').getByTestId('request-row-amount')).toHaveText(
		/Estimate\s*from \$985/
	);
	await expect(row(page, 'Dan').getByTestId('request-row-amount')).not.toContainText('Balance');
	await expect(row(page, 'Sofia').getByTestId('request-row-amount')).toHaveText(/Quote\s*\$1,240/);
	await expect(row(page, 'Hannah').getByTestId('request-row-stage')).toHaveText('Declined');
	await expect(row(page, 'Hannah').getByTestId('request-row-amount')).toHaveText(
		/Declined estimate\s*\$380/
	);
	await expect(row(page, 'Marcus').getByTestId('request-row-stage')).toHaveText('Closed');
	await expect(row(page, 'Maya').locator('time')).toHaveAttribute('datetime', '2026-07-25');
	await expect(row(page, 'Maya').locator('time')).toHaveText('Jul 25');
	await expect(row(page, 'Maya')).toContainText('maya.torres@example.com · Submitted Jul 14');
});

test('reads exactly one collection page per load, through the server, uncached', async ({
	page,
	context
}) => {
	await page.goto('/requests?filter=quoted&q=%20Ortiz%20');
	const before = await session(context);
	const browserUrls: string[] = [];
	page.on('request', (request) => browserUrls.push(request.url()));
	const response = await page.reload();
	await expect(names(page)).toHaveText(['Lena Ortiz']);
	const after = await session(context);
	expect(after.readPaths.slice(before.readPaths.length)).toEqual(['/auth/me', '/staff/requests']);
	expect(after.requestListReads - before.requestListReads).toBe(1);
	expect(after.dashboardReads).toBe(before.dashboardReads);
	expect(after.requestListQueries.at(-1)).toBe('?filter=quoted&q=Ortiz');
	expect(browserUrls.some((url) => url.startsWith(stubUrl))).toBe(false);
	expect(response?.headers()['cache-control']).toBe('no-store');
});

test('searches names and emails, partially and case-insensitively, with filters and clearing', async ({
	page
}) => {
	await page.goto('/requests');
	await search(page, 'SOFIA');
	await expect(page).toHaveURL('/requests?q=SOFIA');
	await expect(names(page)).toHaveText(['Sofia Ramirez-Delacruz']);
	await expect(count(page)).toHaveText('1 request matching “SOFIA”');
	await search(page, 'whitfieldco');
	await expect(names(page)).toHaveText(['Dan Whitfield']);
	await search(page, 'Example.Org');
	await expect(names(page)).toHaveText(['Oliver Grant']);
	await search(page, 'an');
	await expect(names(page)).toHaveText([
		'Sofia Ramirez-Delacruz',
		'Hannah Kim',
		'Priya Nathan',
		'Dan Whitfield',
		'Oliver Grant'
	]);
	await search(page, sofiaId);
	await expect(names(page)).toHaveText(['Sofia Ramirez-Delacruz']);
	// A filter keeps the search; the search keeps the filter.
	await filters(page).getByRole('link', { name: 'Quoted' }).click();
	await expect(page).toHaveURL(`/requests?filter=quoted&q=${sofiaId}`);
	await search(page, 'ortiz');
	await expect(page).toHaveURL('/requests?filter=quoted&q=ortiz');
	await expect(names(page)).toHaveText(['Lena Ortiz']);
	await filters(page).getByRole('link', { name: 'Booked' }).click();
	await expect(page).toHaveURL('/requests?filter=booked&q=ortiz');
	await expect(searchBox(page)).toHaveValue('ortiz');
	await expect(page.getByTestId('request-list-empty')).toHaveText(
		/No requests match “ortiz”\.\s*Clear search/
	);
	await expect(page.getByRole('alert')).toHaveCount(0);
	await page.getByTestId('request-list-empty').getByRole('link', { name: 'Clear search' }).click();
	await expect(page).toHaveURL('/requests?filter=booked');
	await expect(searchBox(page)).toHaveValue('');
	await expect(names(page)).toHaveText(['Priya Nathan', 'Oliver Grant']);
	await expect(page.getByRole('link', { name: 'Clear search' })).toHaveCount(0);
	// The search field's own Clear search link.
	await search(page, 'grant');
	await page.getByRole('search').getByRole('link', { name: 'Clear search' }).click();
	await expect(page).toHaveURL('/requests?filter=booked');
});

test('pages forward with backend cursors; reload and history keep each page', async ({
	page,
	context
}) => {
	await session(context, { pageSize: 3 });
	await page.goto('/requests');
	await expect(names(page)).toHaveText(everyone.slice(0, 3));
	await expect(count(page)).toHaveText('8 requests');
	await expect(page.getByRole('link', { name: 'First page' })).toHaveCount(0);
	await page.getByTestId('next-page').click();
	await expect(page).toHaveURL(/\/requests\?cursor=[\w-]+$/);
	await expect(names(page)).toHaveText(everyone.slice(3, 6));
	const second = page.url();
	await page.reload();
	await expect(names(page)).toHaveText(everyone.slice(3, 6));
	await page.getByTestId('next-page').click();
	// The final page omits nextCursor: no Next page.
	await expect(names(page)).toHaveText(everyone.slice(6));
	await expect(page.getByTestId('next-page')).toHaveCount(0);
	await expect(count(page)).toHaveText('8 requests');
	await page.goBack();
	await expect(page).toHaveURL(second);
	await expect(names(page)).toHaveText(everyone.slice(3, 6));
	await page.getByRole('link', { name: 'First page' }).click();
	await expect(page).toHaveURL('/requests');
	await expect(names(page)).toHaveText(everyone.slice(0, 3));
	// A filter change starts again at page one.
	await page.getByTestId('next-page').click();
	await filters(page).getByRole('link', { name: 'New' }).click();
	await expect(page).toHaveURL('/requests?filter=new');
	await expect(names(page)).toHaveText(['Maya Torres', 'Dan Whitfield']);
	await expect(page.getByTestId('next-page')).toHaveCount(0);
});

test('a workspace opened from results returns to the same filter, search and page, through a deposit', async ({
	page,
	context
}) => {
	await session(context, { pageSize: 1 });
	await page.goto('/requests');
	await filters(page).getByRole('link', { name: 'Quoted' }).click();
	await search(page, 'example');
	await expect(page).toHaveURL('/requests?filter=quoted&q=example');
	await expect(names(page)).toHaveText(['Sofia Ramirez-Delacruz']);
	await page.getByTestId('next-page').click();
	await expect(names(page)).toHaveText(['Lena Ortiz']);
	const results = page.url();
	const listQuery = new URL(results).search.slice(1);
	await row(page, 'Lena').click();
	await expect(page).toHaveURL(`/requests/${lenaId}?${from(listQuery)}`);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lena Ortiz');
	await expect(back(page)).toHaveText('← Back to requests');
	await expect(back(page)).toHaveAttribute(
		'href',
		new URL(results).pathname + new URL(results).search
	);
	// Opening the payment panel keeps the context.
	await page.getByTestId('open-payment').click();
	await expect(page).toHaveURL(`/requests/${lenaId}?payment&${from(listQuery)}`);
	await expect(back(page)).toHaveText('← Back to requests');
	await back(page).click();
	await expect(page).toHaveURL(results);
	await expect(searchBox(page)).toHaveValue('example');
	await expect(filters(page).locator('[aria-current="page"]')).toHaveText('Quoted');
	await expect(names(page)).toHaveText(['Lena Ortiz']);
	// A mutation's Post/Redirect/Get keeps the context, then the list shows the new truth.
	await row(page, 'Lena').click();
	await page.getByTestId('open-payment').click();
	await page.getByRole('button', { name: 'Record $112 deposit' }).click();
	await expect(page).toHaveURL(`/requests/${lenaId}?${from(listQuery)}`);
	await expect(page.getByTestId('request-summary')).toContainText('On the calendar');
	await back(page).click();
	await expect(page).toHaveURL(results);
	// Lena is booked now, so this Quoted page has nothing left; the recovery keeps the criteria.
	await expect(page.getByTestId('request-list-empty')).toContainText(
		'There are no more results here.'
	);
	await page.getByRole('link', { name: 'Start from the first page' }).click();
	await expect(page).toHaveURL('/requests?filter=quoted&q=example');
	await expect(names(page)).toHaveText(['Sofia Ramirez-Delacruz']);
	await expect(count(page)).toHaveText('1 request matching “example”');
});

test('Quote and Decline panels keep the return link, and a decline PRGs back with it', async ({
	page
}) => {
	await page.goto('/requests?filter=new');
	await row(page, 'Maya').click();
	const context = from('filter=new');
	await expect(page).toHaveURL(`/requests/${mayaId}?${context}`);
	await page.getByTestId('build-quote').click();
	await expect(page).toHaveURL(`/requests/${mayaId}?quote&${context}`);
	await expect(page.getByTestId('quote-builder')).toBeVisible();
	await expect(back(page)).toHaveAttribute('href', '/requests?filter=new');
	await page.getByTestId('quote-builder').getByRole('link', { name: 'Cancel' }).click();
	await expect(page).toHaveURL(`/requests/${mayaId}?${context}`);
	await page.getByTestId('decline-request').click();
	await expect(page).toHaveURL(`/requests/${mayaId}?decline&${context}`);
	await expect(back(page)).toHaveAttribute('href', '/requests?filter=new');
	await page.getByRole('textbox', { name: 'Reason for declining' }).fill('Date unavailable.');
	await page.getByRole('button', { name: 'Decline request' }).click();
	await expect(page).toHaveURL(`/requests/${mayaId}?${context}`);
	await expect(page.getByTestId('decline-record')).toBeVisible();
	await back(page).click();
	await expect(page).toHaveURL('/requests?filter=new');
	// The declined request left New and stays discoverable under Declined.
	await expect(names(page)).toHaveText(['Dan Whitfield']);
	await filters(page).getByRole('link', { name: 'Declined' }).click();
	await expect(names(page)).toHaveText(['Maya Torres', 'Hannah Kim']);
	await row(page, 'Hannah').click();
	await expect(page).toHaveURL(`/requests/${hannahId}?${from('filter=declined')}`);
	await expect(page.getByTestId('decline-record')).toContainText('Fully booked that weekend.');
});

for (const native of [false, true]) {
	test.describe(native ? 'native quote issuance' : 'enhanced quote issuance', () => {
		test.use({ javaScriptEnabled: !native });
		test('a quote issued from filtered results keeps the return context through preview and PRG', async ({
			page,
			context
		}) => {
			const listQuery = 'filter=new&q=maya';
			const workspace = `/requests/${mayaId}?${from(listQuery)}`;
			await page.goto(`/requests?${listQuery}`);
			await row(page, 'Maya').click();
			await expect(page).toHaveURL(workspace);
			await page.getByTestId('build-quote').click();
			await expect(page).toHaveURL(`/requests/${mayaId}?quote&${from(listQuery)}`);
			await expect(page.getByTestId('quote-builder')).toBeVisible();
			const builder = page.getByTestId('quote-builder');
			if (native) {
				// A native preview re-renders at its action URL, which still carries the context.
				await page.getByRole('button', { name: 'Update preview', exact: true }).click();
				await expect(page).toHaveURL(`/requests/${mayaId}?quote&${from(listQuery)}&/previewQuote`);
				await expect(page.getByTestId('quote-deposit')).toContainText('$83');
				expect(await destination(back(page))).toBe(`/requests?${listQuery}`);
				expect(await destination(builder.getByRole('link', { name: 'Cancel' }))).toBe(workspace);
				await issueButton(page).click();
			} else {
				await waitForPreview(page);
				expect(await destination(back(page))).toBe(`/requests?${listQuery}`);
				expect(await destination(builder.getByRole('link', { name: 'Cancel' }))).toBe(workspace);
				const response = page.waitForResponse(
					(response) =>
						response.request().method() === 'POST' && response.url().includes('issueQuote')
				);
				await previewThenIssue(page);
				expect(await (await response).json()).toMatchObject({
					type: 'redirect',
					status: 303,
					location: workspace
				});
			}
			// Post/Redirect/Get lands on the clean workspace, context intact, with the issued Quote.
			await expect(page).toHaveURL(workspace);
			await expect(page.getByTestId('quote-builder')).toHaveCount(0);
			await expect(page.getByTestId('request-summary')).toContainText('Quote issued');
			await expect(page.getByTestId('financial-version')).toContainText('Quote v2');
			const attempts = (await session(context)).proposalAttempts;
			expect(attempts).toHaveLength(1);
			expect(attempts[0]).toMatchObject({
				inquiryId: mayaId,
				body: { expectedDocumentVersion: 1 }
			});
			await back(page).click();
			await expect(page).toHaveURL(`/requests?${listQuery}`);
			await expect(searchBox(page)).toHaveValue('maya');
			// Maya left New; the search carries over to where she is now.
			await expect(page.getByTestId('request-list-empty')).toContainText(
				'No requests match “maya”.'
			);
			await filters(page).getByRole('link', { name: 'Quoted' }).click();
			await expect(page).toHaveURL('/requests?filter=quoted&q=maya');
			await expect(names(page)).toHaveText(['Maya Torres']);
			await expect(row(page, 'Maya').getByTestId('request-row-stage')).toHaveText('Quoted');
			expect((await session(context)).proposalAttempts).toHaveLength(1);
		});
	});
}

for (const [name, value] of [
	['an absolute URL', 'https://evil.example/requests'],
	['a protocol-relative URL', '//evil.example'],
	['another admin path', '/logout'],
	['an unexpected parameter', 'filter=all&next=https://evil.example']
]) {
	test(`a return destination of ${name} falls back to the dashboard`, async ({ page }) => {
		await page.goto(`/requests/${mayaId}?from=${encodeURIComponent(value)}`);
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Maya Torres');
		await expect(back(page)).toHaveText('← Back to dashboard');
		await expect(back(page)).toHaveAttribute('href', '/');
		await expect(page.locator('a[href*="evil"], form[action*="evil"]')).toHaveCount(0);
		await back(page).click();
		await expect(page).toHaveURL('/');
	});
}

test('forbidden, unavailable and malformed collections show safe states without results', async ({
	page,
	context
}) => {
	for (const [listMode, heading, copy] of [
		['list-forbidden', 'Requests access unavailable', 'This account cannot view requests.'],
		['list-unavailable', 'Requests unavailable', 'We couldn’t load requests. Try again shortly.'],
		['list-malformed', 'Requests unavailable', 'We couldn’t load requests. Try again shortly.']
	]) {
		await session(context, { listMode });
		await page.goto('/requests?filter=quoted');
		const alert = page.getByRole('alert');
		await expect(alert.getByRole('heading')).toHaveText(heading);
		await expect(alert).toContainText(copy);
		await expect(rows(page)).toHaveCount(0);
		await expect(count(page)).toHaveCount(0);
		await expect(page.getByText('PRIVATE', { exact: false })).toHaveCount(0);
		await expect(page.getByText(/\$0\b/)).toHaveCount(0);
		// Filters and search stay available unless the account can't read requests at all.
		await expect(page.getByRole('search')).toHaveCount(listMode === 'list-forbidden' ? 0 : 1);
	}
	await session(context, { listMode: 'list-unavailable' });
	await page.reload();
	await session(context, { listMode: null });
	await page.getByRole('link', { name: 'Try again' }).click();
	await expect(page).toHaveURL('/requests?filter=quoted');
	await expect(names(page)).toHaveText(['Sofia Ramirez-Delacruz', 'Lena Ortiz']);
});

test('an expired cursor or unknown filter recovers safely, keeping valid criteria', async ({
	page,
	context
}) => {
	const before = await session(context);
	await page.goto('/requests?filter=quoted&q=ortiz&cursor=bm90LWEtY3Vyc29y');
	await expect(page.getByRole('alert')).toContainText(
		'This page of results is no longer available.'
	);
	await expect(page.getByText('PRIVATE', { exact: false })).toHaveCount(0);
	expect((await session(context)).requestListReads - before.requestListReads).toBe(1);
	await page.getByRole('link', { name: 'Start from the first page' }).click();
	await expect(page).toHaveURL('/requests?filter=quoted&q=ortiz');
	await expect(names(page)).toHaveText(['Lena Ortiz']);
	// An explicitly empty cursor is malformed (as the API says), not the first page.
	const reads = (await session(context)).requestListReads;
	await page.goto('/requests?filter=quoted&q=ortiz&cursor=');
	await expect(page.getByRole('alert')).toContainText(
		'This page of results is no longer available.'
	);
	expect((await session(context)).requestListReads).toBe(reads);
	await page.getByRole('link', { name: 'Start from the first page' }).click();
	await expect(page).toHaveURL('/requests?filter=quoted&q=ortiz');
	await expect(names(page)).toHaveText(['Lena Ortiz']);
	await page.goto('/requests?filter=archived&q=lee');
	await expect(page.getByRole('alert')).toContainText('This filter isn’t available.');
	await page.getByRole('alert').getByRole('link', { name: 'View all requests' }).click();
	await expect(page).toHaveURL('/requests?q=lee');
	await expect(names(page)).toHaveText(['Marcus Lee']);
});

test('the index fits narrow and wide viewports with long names, emails and amounts', async ({
	page,
	isMobile
}, testInfo) => {
	if (!isMobile) await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto('/requests');
	await expect(rows(page)).toHaveCount(8);
	await expect(row(page, 'Sofia')).toContainText(
		'sofia.ramirez-delacruz.celebrations.and.weddings@example-events.com'
	);
	await noOverflow(page);
	for (const link of await filters(page).getByRole('link').all()) {
		const box = await link.boundingBox();
		expect(box?.height).toBeGreaterThanOrEqual(44);
	}
	const searchBoxSize = await searchBox(page).boundingBox();
	expect(searchBoxSize?.height).toBeGreaterThanOrEqual(44);
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({ path: testInfo.outputPath('requests.png'), fullPage: true });
	await page.goto('/');
	await noOverflow(page);
});

test.describe('without JavaScript', () => {
	test.use({ javaScriptEnabled: false });
	test('filters, search, pagination, opening a request and returning all work natively', async ({
		page,
		context
	}) => {
		await session(context, { pageSize: 1 });
		await page.goto('/');
		await page.getByTestId('summary-card').filter({ hasText: 'Quoted' }).click();
		await expect(page).toHaveURL('/requests?filter=quoted');
		await expect(names(page)).toHaveText(['Sofia Ramirez-Delacruz']);
		await searchBox(page).fill('o');
		await searchBox(page).press('Enter');
		await expect(page).toHaveURL('/requests?filter=quoted&q=o');
		await page.getByTestId('next-page').click();
		await expect(names(page)).toHaveText(['Lena Ortiz']);
		const results = page.url();
		await row(page, 'Lena').click();
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lena Ortiz');
		await page.getByTestId('open-payment').click();
		await expect(page.getByTestId('payment-form')).toBeVisible();
		await back(page).click();
		await expect(page).toHaveURL(results);
		await expect(searchBox(page)).toHaveValue('o');
		await filters(page).getByRole('link', { name: 'All requests' }).click();
		await expect(page).toHaveURL('/requests?q=o');
		await page.getByRole('search').getByRole('link', { name: 'Clear search' }).click();
		await expect(page).toHaveURL('/requests');
		await expect(names(page)).toHaveText(['Maya Torres']);
	});
});
