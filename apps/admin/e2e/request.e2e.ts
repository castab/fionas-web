import { expect, test } from '@playwright/test';
import { mayaId, requestFixtures } from './request-fixture.mjs';
import {
	issueButton,
	openBuilder,
	openMaya,
	previewThenIssue,
	route,
	session,
	signIn,
	stubUrl
} from './request-helpers.js';

const keptEstimate = (terms: unknown) => ({
	expectedDocumentVersion: 1,
	terms,
	composition: { pricing: { mode: 'KEEP_ESTIMATE' } },
	reviewToken: expect.stringMatching(/^[0-9a-f]{64}$/)
});

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
	await expect(page.getByTestId('build-quote')).toBeVisible();
	await expect(page.getByTestId('quote-builder')).toHaveCount(0);
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
		page.getByTestId('original-request').getByText('hand-scooped-chocolate-chip', { exact: true })
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
	// Catalog choices are read only once the builder opens.
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

test('issues the previewed quote, lands on a fresh Quote and never resubmits on refresh', async ({
	page,
	context
}) => {
	await openMaya(page);
	const browserUrls: string[] = [];
	page.on('request', (request) => browserUrls.push(request.url()));
	const before = await session(context);
	await openBuilder(page);
	await expect(page.getByTestId('quote-total')).toContainText('$415');
	await expect(page.getByTestId('quote-deposit')).toContainText('$83');
	const response = page.waitForResponse(
		(response) => response.request().method() === 'POST' && response.url().includes('issueQuote')
	);
	await issueButton(page).click();
	const actionResponse = await response;
	expect(await actionResponse.json()).toMatchObject({
		type: 'redirect',
		status: 303,
		location: route
	});
	await expect(page).toHaveURL(route);
	await expect(page.getByTestId('request-summary')).toContainText('Quote issued');
	await expect(page.getByTestId('deposit-summary')).toContainText('$83');
	await expect(page.getByTestId('deposit-summary')).toContainText('20% of quote');
	await expect(page.getByTestId('deposit-summary')).toContainText('Awaiting deposit');
	await expect(page.getByTestId('request-summary')).not.toContainText('Needs a quote');
	await expect(page.getByTestId('financial-document')).toContainText('Current quote · Version 2');
	await expect(page.getByTestId('service-plan')).toContainText('Approved with quote version 2');
	await expect(page.getByTestId('service-plan')).toContainText('Waffle cones');
	await expect(page.getByLabel('Request lifecycle').locator('[aria-current="step"]')).toHaveText(
		'Quoted'
	);
	await expect(page.getByTestId('build-quote')).toHaveCount(0);
	await expect(issueButton(page)).toHaveCount(0);
	await expect(page.getByText(/Quote sent|Customer notified|Email delivered/)).toHaveCount(0);
	const after = await session(context);
	expect(after.proposalAttempts).toEqual([
		{ inquiryId: mayaId, body: keptEstimate({ type: 'PERCENTAGE', percentage: '20' }) }
	]);
	expect(after.previewAttempts).toHaveLength(1);
	// Builder load, preview action, issue action and the confirming GET.
	expect(after.requestReads - before.requestReads).toBe(4);
	expect(browserUrls.some((url) => url.startsWith(stubUrl))).toBe(false);
	await page.reload();
	expect((await session(context)).proposalAttempts).toHaveLength(1);
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
	await openBuilder(page);
	const newer = requestFixtures()[mayaId];
	newer.financial.version = 2;
	await session(context, { request: newer });
	await issueButton(page).click();
	await expect(page.getByRole('alert').first()).toContainText(
		'This request changed since you opened it. Reload to review'
	);
	await expect(issueButton(page)).toBeDisabled();
	await expect(page.getByTestId('financial-document')).toContainText('Version 1');
	// The reviewed service belongs to Estimate v1, so the newer read refuses before any mutation.
	expect((await session(context)).proposalAttempts).toEqual([]);
	await expect(page.getByText('PRIVATE', { exact: false })).toHaveCount(0);
	await page.getByRole('link', { name: 'Reload to review' }).click();
	await expect(page.getByTestId('financial-document')).toContainText('Version 2');
	await expect(page.getByTestId('build-quote')).toBeVisible();
	expect((await session(context)).proposalAttempts).toHaveLength(0);
});

for (const mode of [
	'proposal-forbidden',
	'proposal-not-found',
	'proposal-conflict',
	'proposal-unavailable',
	'proposal-ambiguous'
]) {
	test(`${mode} requires reload/review without leaking private diagnostics or replaying`, async ({
		page,
		context
	}) => {
		await openMaya(page);
		await openBuilder(page);
		await session(context, { mode });
		await issueButton(page).click();
		await expect(page.getByRole('alert').first()).toBeVisible();
		await expect(page.getByText('PRIVATE', { exact: false })).toHaveCount(0);
		await expect(issueButton(page)).toBeDisabled();
		expect((await session(context)).proposalAttempts).toHaveLength(1);
		if (mode === 'proposal-unavailable' || mode === 'proposal-ambiguous')
			await expect(page.getByRole('alert').first()).toContainText('couldn’t confirm whether');
		await page.getByRole('link', { name: 'Reload to review' }).click();
		if (mode === 'proposal-ambiguous') {
			await expect(page.getByTestId('request-summary')).toContainText('Quote issued');
			await expect(page.getByTestId('build-quote')).toHaveCount(0);
		}
		expect((await session(context)).proposalAttempts).toHaveLength(1);
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
	await expect(page.getByTestId('build-quote')).toHaveCount(0);
	await page.goto(`${route}?quote`);
	await expect(page.getByTestId('quote-builder')).toHaveCount(0);
	const state = await session(context);
	expect(state.permissions).not.toContain('commerce.financial-document.create');
	expect(state.proposalAttempts).toHaveLength(0);
	expect(state.readPaths).not.toContain('/offering-catalog');
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

for (const native of [false, true]) {
	test.describe(native ? 'native deposit forms' : 'enhanced deposit forms', () => {
		test.use({ javaScriptEnabled: !native });
		test('preserves a keyboard-selected exact custom percentage', async ({ page, context }) => {
			await openMaya(page);
			await openBuilder(page, native);
			const recommended = page.getByRole('radio', { name: 'Recommended 20% of quote' });
			await recommended.focus();
			await recommended.press('ArrowDown');
			await expect(
				page.getByRole('radio', { name: 'Custom percentage', exact: true })
			).toBeChecked();
			await page.getByLabel('Deposit percentage', { exact: true }).fill('017.500');
			if (!native) await expect(page.getByTestId('quote-deposit')).toContainText('$72.63');
			await previewThenIssue(page, native);
			await expect(page.getByTestId('deposit-summary')).toContainText('$72.63');
			await expect(page.getByTestId('deposit-summary')).toContainText('017.500% of quote');
			expect((await session(context)).proposalAttempts).toEqual([
				{
					inquiryId: mayaId,
					body: keptEstimate({ type: 'PERCENTAGE', percentage: '017.500' })
				}
			]);
		});
		test('allows correction of invalid fixed terms and backend minor-unit rejection', async ({
			page,
			context
		}) => {
			await openMaya(page);
			await openBuilder(page, native);
			await page.getByRole('radio', { name: 'Fixed amount', exact: true }).check();
			const input = page.getByLabel('Deposit amount (USD)', { exact: true });
			await input.fill('0');
			if (native) await page.getByRole('button', { name: 'Update preview', exact: true }).click();
			else await input.blur();
			await expect(input).toHaveAttribute('aria-invalid', 'true');
			if (native) await expect(page.getByRole('alert').first()).toContainText('highlighted fields');
			else await expect(issueButton(page)).toBeDisabled();
			await input.fill('123.001');
			if (native) await page.getByRole('button', { name: 'Update preview', exact: true }).click();
			await expect(page.getByRole('alert').first()).toContainText('couldn’t be accepted');
			await expect(input).toHaveValue('123.001');
			expect((await session(context)).proposalAttempts).toHaveLength(0);
			await input.fill('123.40');
			if (!native) await expect(page.getByTestId('quote-deposit')).toContainText('$123.40');
			await previewThenIssue(page, native);
			await expect(page).toHaveURL(route);
			await expect(page.getByTestId('deposit-summary')).toContainText('$123.40');
			await expect(page.getByTestId('deposit-summary')).toContainText('Fixed deposit');
			expect((await session(context)).proposalAttempts.at(-1).body.terms).toEqual({
				type: 'FIXED',
				amount: '123.40',
				currency: 'USD'
			});
		});
		test('blocks changed suggestions without posting and uses a refreshed backend recommendation', async ({
			page,
			context
		}) => {
			await openMaya(page);
			await openBuilder(page, native);
			const changed = requestFixtures()[mayaId];
			changed.suggestedDepositTerms = { type: 'PERCENTAGE', percentage: '25' };
			await session(context, { request: changed });
			await issueButton(page).click();
			await expect(page.getByRole('alert').first()).toContainText('Reload to review');
			await expect(issueButton(page)).toBeDisabled();
			expect((await session(context)).proposalAttempts).toHaveLength(0);
			await page.getByRole('link', { name: 'Reload to review' }).click();
			await openBuilder(page, native);
			await expect(page.getByRole('radio', { name: 'Recommended 25% of quote' })).toBeChecked();
			await previewThenIssue(page, native);
			await expect(page.getByTestId('deposit-summary')).toContainText('$103.75');
		});
		test('displays and issues a backend fixed suggestion', async ({ page, context }) => {
			const changed = requestFixtures()[mayaId];
			changed.suggestedDepositTerms = { type: 'FIXED', amount: '125.00', currency: 'USD' };
			await session(context, { request: changed });
			await page.goto(route);
			await openBuilder(page, native);
			await expect(
				page.getByRole('radio', { name: 'Recommended Fixed deposit · $125' })
			).toBeChecked();
			await previewThenIssue(page, native);
			await expect(page.getByTestId('deposit-summary')).toContainText('$125');
			expect((await session(context)).proposalAttempts[0].body.terms).toEqual(
				changed.suggestedDepositTerms
			);
		});
		test('commit then 500 requires reload and never replays', async ({ page, context }) => {
			await openMaya(page);
			await openBuilder(page, native);
			await session(context, { mode: 'proposal-ambiguous' });
			await previewThenIssue(page, native);
			await expect(page.getByRole('alert').first()).toContainText('couldn’t confirm whether');
			const button = issueButton(page);
			if (await button.count()) await expect(button).toBeDisabled();
			expect((await session(context)).proposalAttempts).toHaveLength(1);
			await page.getByRole('link', { name: 'Reload to review' }).click();
			await expect(page.getByTestId('request-summary')).toContainText('Quote issued');
			await expect(page.getByTestId('deposit-summary')).toContainText('$83');
			expect((await session(context)).proposalAttempts).toHaveLength(1);
		});
	});
}

for (const permissions of [
	[],
	['commerce.financial-document.create'],
	['commerce.deposit-requirement.manage']
]) {
	test(`partial proposal permissions ${permissions.join(',') || 'neither'} hide and deny issuance`, async ({
		page,
		context
	}) => {
		await session(context, {
			permissions: ['fionas.inquiries.read', 'commerce.financial-document.read', ...permissions]
		});
		await page.goto(route);
		await expect(page.getByTestId('build-quote')).toHaveCount(0);
		for (const action of ['previewQuote', 'issueQuote']) {
			const result = await context.request.post(`${route}?quote&/${action}`, {
				form: {
					expectedVersion: '1',
					depositChoice: 'suggested',
					reviewedSuggestionType: 'PERCENTAGE',
					reviewedSuggestionValue: '20'
				}
			});
			expect(result.status()).toBe(403);
		}
		const state = await session(context);
		expect(state.proposalAttempts).toHaveLength(0);
		expect(state.previewAttempts).toHaveLength(0);
	});
}

test('booked Invoice retains the accepted deposit after a refund', async ({ page, context }) => {
	const data = requestFixtures()['00000000-0000-0000-0000-000000000001'];
	data.inquiry.lifecycle.stage = 'BOOKED';
	data.financial.stage = 'INVOICE';
	data.financial.version = 3;
	if (data.depositRequirement.state === 'ACTIVE') data.depositRequirement.satisfied = false;
	await session(context, { request: data });
	await page.goto(`/requests/${data.inquiry.id}`);
	await expect(page.getByTestId('request-summary')).toContainText('Event booked');
	await expect(page.getByTestId('deposit-summary')).toContainText('Booking deposit');
	await expect(page.getByTestId('deposit-summary')).toContainText('$112');
	await expect(page.getByTestId('deposit-summary')).not.toContainText('Awaiting deposit');
	await expect(page.getByTestId('build-quote')).toHaveCount(0);
});

test.describe('native forms', () => {
	test.use({ javaScriptEnabled: false });
	test('a local input failure revealing newer reviewed state requires a clean GET', async ({
		page,
		context
	}) => {
		await openMaya(page);
		await openBuilder(page, true);
		await page.getByRole('radio', { name: 'Fixed amount', exact: true }).check();
		await page.getByLabel('Deposit amount (USD)', { exact: true }).fill('0');
		const newer = requestFixtures()[mayaId];
		newer.financial.version = 2;
		await session(context, { request: newer });
		await page.getByRole('button', { name: 'Update preview', exact: true }).click();
		await expect(page.getByRole('alert').first()).toContainText('Reload to review');
		await expect(issueButton(page)).toBeDisabled();
		const state = await session(context);
		expect(state.proposalAttempts).toHaveLength(0);
		expect(state.previewAttempts).toHaveLength(0);
		await page.getByRole('link', { name: 'Reload to review' }).click();
		await expect(page.getByTestId('build-quote')).toBeVisible();
	});
	test('uses HTTP 303 and GET after issuance, and refresh cannot resubmit', async ({
		page,
		context
	}) => {
		await openMaya(page);
		await openBuilder(page, true);
		await page.getByRole('button', { name: 'Update preview', exact: true }).click();
		await expect(page.getByTestId('quote-deposit')).toContainText('$83');
		const response = page.waitForResponse(
			(response) => response.request().method() === 'POST' && response.url().includes('issueQuote')
		);
		await issueButton(page).click();
		expect((await response).status()).toBe(303);
		await expect(page).toHaveURL(route);
		await expect(page.getByTestId('request-summary')).toContainText('Quote issued');
		await expect(page.getByTestId('financial-document')).toContainText('Current quote · Version 2');
		await page.reload();
		expect((await session(context)).proposalAttempts).toHaveLength(1);
	});
	test('an unreviewed native issue previews first and issues only on a second explicit click', async ({
		page,
		context
	}) => {
		await openMaya(page);
		await openBuilder(page, true);
		await issueButton(page).click();
		await expect(page.getByText('The quote changed since you reviewed it')).toBeVisible();
		await expect(page.getByTestId('quote-deposit')).toContainText('$83');
		expect((await session(context)).proposalAttempts).toHaveLength(0);
		await issueButton(page).click();
		await expect(page.getByTestId('request-summary')).toContainText('Quote issued');
		expect((await session(context)).proposalAttempts).toHaveLength(1);
	});
	test('conflict remains blocked until an explicit GET review, even if the POST render reloads data', async ({
		page,
		context
	}) => {
		await openMaya(page);
		await openBuilder(page, true);
		await page.getByRole('button', { name: 'Update preview', exact: true }).click();
		await expect(page.getByTestId('quote-deposit')).toBeVisible();
		const request = requestFixtures()[mayaId];
		request.financial.version = 2;
		await session(context, { request });
		await issueButton(page).click();
		await expect(page.getByRole('alert').first()).toContainText('Reload to review');
		await expect(issueButton(page)).toBeDisabled();
		await page.getByRole('link', { name: 'Reload to review' }).click();
		await expect(page).toHaveURL(route);
		await expect(page.getByTestId('build-quote')).toBeVisible();
		expect((await session(context)).proposalAttempts).toHaveLength(0);
	});
});
