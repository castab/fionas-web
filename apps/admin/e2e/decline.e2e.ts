import { expect, test, type Page } from '@playwright/test';
import { declinedFixture, mayaId, requestFixtures } from './request-fixture.mjs';
import { postAction, route, session, signIn } from './request-helpers.js';

const quotedId = '00000000-0000-0000-0000-000000000001';
const uncertain =
	'We couldn’t confirm whether this request was declined. Reload to review its latest status before taking another action.';
const panel = (page: Page) => page.locator('#decline-request');
const reasonField = (page: Page) => page.getByRole('textbox', { name: 'Reason for declining' });
const declineButton = (page: Page) => page.getByRole('button', { name: 'Decline request' });
const headline = (page: Page) => page.getByTestId('request-summary').getByRole('heading');

async function openDecline(page: Page) {
	await page.getByTestId('decline-request').click();
	await expect(page).toHaveURL(`${route}?decline`);
	await expect(panel(page)).toBeVisible();
}

test.beforeEach(async ({ page, context }) => {
	await signIn(page);
	await session(context, { request: requestFixtures()[mayaId] });
});

for (const native of [false, true])
	test.describe(native ? 'native decline' : 'enhanced decline', () => {
		test.use({ javaScriptEnabled: !native });

		test('confirmation explains the decision; Keep request changes nothing', async ({
			page,
			context
		}) => {
			await page.goto(route);
			await openDecline(page);
			await expect(panel(page)).toHaveAccessibleName('Decline this request?');
			await expect(panel(page)).toContainText('Maya Torres · Saturday, July 25 · Birthday party');
			await expect(panel(page)).toContainText('removes the request from your active work');
			await expect(panel(page)).toContainText('will remain on file');
			await expect(panel(page)).toContainText('will not be notified automatically');
			await expect(panel(page)).toContainText('can’t reopen a declined request');
			await expect(reasonField(page)).toBeFocused();
			await expect(reasonField(page)).toHaveAccessibleDescription(/Internal staff note/);
			await expect(reasonField(page)).toHaveAttribute('maxlength', '500');
			await page.getByRole('link', { name: 'Keep request' }).click();
			await expect(page).toHaveURL(route);
			await expect(panel(page)).toHaveCount(0);
			await expect(headline(page)).toHaveText('Needs a quote');
			expect((await session(context)).declineAttempts).toEqual([]);
		});

		test('a blank or whitespace reason is refused before any decline', async ({
			page,
			context
		}) => {
			await page.goto(route);
			await openDecline(page);
			for (const reason of ['', '  \n\t  ']) {
				await reasonField(page).fill(reason);
				await declineButton(page).click();
				await expect(page.getByRole('alert')).toContainText('Enter a reason for declining.');
				await expect(reasonField(page)).toHaveAttribute('aria-invalid', 'true');
				await expect(reasonField(page)).toHaveAccessibleDescription(
					/Enter a reason for declining\./
				);
				await expect(reasonField(page)).toHaveValue(reason);
				await expect(declineButton(page)).toBeEnabled();
				await expect(page.getByRole('link', { name: 'Keep request' })).toBeVisible();
			}
			expect((await session(context)).declineAttempts).toEqual([]);
		});

		test('declines once with the reviewed version, then reloads the authoritative DECLINED state', async ({
			page,
			context
		}, testInfo) => {
			await page.goto(route);
			if (native) await openDecline(page);
			else {
				// Keyboard only: focus Decline, open it, type, Tab to the submit and press Enter.
				await page.getByTestId('decline-request').focus();
				await page.keyboard.press('Enter');
				await expect(panel(page)).toBeVisible();
				await expect(reasonField(page)).toBeFocused();
			}
			await reasonField(page).fill('  Requested date is unavailable.\nOffered Nov 21 instead.  ');
			await page.screenshot({ path: testInfo.outputPath('decline-confirm.png'), fullPage: true });
			const before = await session(context);
			if (native) await declineButton(page).click();
			else {
				await page.keyboard.press('Tab');
				await expect(declineButton(page)).toBeFocused();
				await page.keyboard.press('Enter');
			}
			await expect(page).toHaveURL(route);
			await expect(headline(page)).toHaveText('Request declined');
			const after = await session(context);
			expect(after.declineAttempts).toEqual([
				{
					inquiryId: mayaId,
					body: {
						expectedDocumentVersion: 1,
						reason: 'Requested date is unavailable.\nOffered Nov 21 instead.'
					},
					raw: expect.any(String)
				}
			]);
			// The confirming GET is the authority, not the mutation response.
			expect(after.requestReads - before.requestReads).toBe(2);
			await expect(
				page.getByRole('main').getByText('Declined', { exact: true }).first()
			).toBeVisible();
			const record = page.getByTestId('decline-record');
			await expect(record).toContainText('Oct 20, 2026, 1:00 PM (Pacific)');
			await expect(record).toContainText('Requested date is unavailable.');
			await expect(record).toContainText('Offered Nov 21 instead.');
			await expect(record).toContainText('You');
			await expect(record).toContainText('Estimate v1');
			await expect(page.getByLabel('Request lifecycle: declined after Requested')).toBeVisible();
			await expect(page.locator('[aria-current="step"]')).toHaveCount(0);
			// History stays: customer, request, notes and the canonical Estimate.
			await expect(page.getByTestId('event-card')).toContainText('Saturday, July 25');
			await expect(page.getByTestId('event-card')).toContainText('maya.torres@example.com');
			await expect(page.getByTestId('original-request')).toContainText('Waffle cones');
			await expect(page.getByTestId('original-request')).toContainText('loves strawberry');
			await expect(page.getByTestId('financial-version')).toHaveText('Estimate v1');
			await expect(page.getByTestId('financial-document')).toContainText('$415');
			await expect(page.getByTestId('financial-document')).not.toContainText('Current balance');
			// Nothing further to do.
			for (const id of ['build-quote', 'decline-request', 'open-payment', 'fulfillment-form'])
				await expect(page.getByTestId(id)).toHaveCount(0);
			await page.screenshot({ path: testInfo.outputPath('declined.png'), fullPage: true });
			await page.reload();
			await expect(headline(page)).toHaveText('Request declined');
			expect((await session(context)).declineAttempts).toHaveLength(1);
			// The backend drops it from every queue; the dashboard just renders that.
			await page.getByRole('link', { name: 'Back to dashboard' }).click();
			await expect(page.getByTestId('request-card').filter({ hasText: 'Maya Torres' })).toHaveCount(
				0
			);
		});

		test('a stale reviewed version blocks every mutation until a clean reload', async ({
			page,
			context
		}) => {
			await page.goto(route);
			await openDecline(page);
			const newer = requestFixtures()[mayaId];
			newer.financial.version = 2;
			await session(context, { request: newer });
			await reasonField(page).fill('Date unavailable.');
			await declineButton(page).click();
			await expect(page.getByRole('alert')).toContainText(
				'changed or has already been handled since you opened it'
			);
			await expect(declineButton(page)).toBeDisabled();
			await expect(page.getByRole('link', { name: 'Keep request' })).toHaveCount(0);
			await expect(page.getByTestId('build-quote')).toHaveAttribute('aria-disabled', 'true');
			expect((await session(context)).declineAttempts).toEqual([]);
			await page.getByRole('link', { name: 'Reload to review' }).first().click();
			await expect(page).toHaveURL(route);
			await expect(panel(page)).toHaveCount(0);
			await expect(page.getByTestId('build-quote')).not.toHaveAttribute('aria-disabled', 'true');
		});

		for (const mode of ['decline-conflict', 'decline-ambiguous', 'decline-unavailable'])
			test(`${mode} requires review and is never repeated`, async ({ page, context }) => {
				await page.goto(route);
				await openDecline(page);
				await session(context, { mode, request: requestFixtures()[mayaId] });
				await reasonField(page).fill('Date unavailable.');
				await declineButton(page).click();
				await expect(page.getByRole('alert')).toContainText(
					mode === 'decline-conflict' ? 'Reload to review its latest status' : uncertain
				);
				await expect(page.getByText('PRIVATE', { exact: false })).toHaveCount(0);
				await expect(declineButton(page)).toBeDisabled();
				await expect(page.getByRole('link', { name: 'Keep request' })).toHaveCount(0);
				// Every remaining mutation entry is blocked. (A native re-render already reads a
				// committed decline, so Build quote and Decline may be gone altogether.)
				for (const id of ['build-quote', 'decline-request'])
					for (const entry of await page.getByTestId(id).all())
						await expect(entry).toHaveAttribute('aria-disabled', 'true');
				expect((await session(context)).declineAttempts).toHaveLength(1);
				await session(context, {
					mode: 'brayan',
					request: (await session(context)).requests[mayaId]
				});
				await page.getByRole('link', { name: 'Reload to review' }).first().click();
				await expect(page).toHaveURL(route);
				// Only the reload says what happened: committed (ambiguous) or not.
				await expect(headline(page)).toHaveText(
					mode === 'decline-ambiguous' ? 'Request declined' : 'Needs a quote'
				);
				expect((await session(context)).declineAttempts).toHaveLength(1);
			});
	});

test('a later Estimate version is the version sent', async ({ page, context }) => {
	const request = requestFixtures()[mayaId];
	request.financial.version = 3;
	await session(context, { request });
	await page.goto(`${route}?decline`);
	await reasonField(page).fill('Fully booked that weekend.');
	await declineButton(page).click();
	await expect(headline(page)).toHaveText('Request declined');
	await expect(page.getByTestId('decline-record')).toContainText('Estimate v3');
	expect((await session(context)).declineAttempts[0].body).toEqual({
		expectedDocumentVersion: 3,
		reason: 'Fully booked that weekend.'
	});
});

test('without fionas.inquiries.manage there is no Decline and a direct POST is refused', async ({
	page,
	context
}) => {
	await session(context, {
		request: requestFixtures()[mayaId],
		permissions: [
			'fionas.inquiries.read',
			'commerce.financial-document.read',
			'commerce.financial-document.create',
			'commerce.deposit-requirement.manage',
			'fionas.financial-terms.manage',
			'commerce.payment.record'
		]
	});
	await page.goto(route);
	await expect(page.getByTestId('build-quote')).toBeVisible();
	await expect(page.getByTestId('decline-request')).toHaveCount(0);
	await page.goto(`${route}?decline`);
	await expect(panel(page)).toHaveCount(0);
	const response = await postAction(page, `${route}?/declineInquiry`, {
		expectedDocumentVersion: '1',
		reason: 'Not allowed'
	});
	expect(response.status).toBe(403);
	expect(response.data).toContain('This account cannot decline requests.');
	const state = await session(context);
	expect(state.declineAttempts).toEqual([]);
});

test('a QUOTED inquiry cannot be declined, even by a direct POST', async ({ page, context }) => {
	await page.goto(`/requests/${quotedId}?decline`);
	await expect(headline(page)).toContainText('Quote issued');
	await expect(page.getByTestId('decline-request')).toHaveCount(0);
	await expect(panel(page)).toHaveCount(0);
	const response = await postAction(page, `/requests/${quotedId}?/declineInquiry`, {
		expectedDocumentVersion: '2',
		reason: 'Too late'
	});
	expect(response.status).toBe(409);
	expect(response.data).toContain('changed or has already been handled');
	expect((await session(context)).declineAttempts).toEqual([]);
});

test('a declined request stays readable with no actions, Quote entry or decline entry', async ({
	page,
	context
}) => {
	await session(context, { request: declinedFixture(2, 'Trailer is in the shop that day.') });
	for (const suffix of ['', '?quote', '?decline', '?payment']) {
		await page.goto(`${route}${suffix}`);
		await expect(headline(page)).toHaveText('Request declined');
		await expect(page.getByTestId('decline-record')).toContainText(
			'Trailer is in the shop that day.'
		);
		// Another staff account recorded it; its id is shown only as audit detail.
		await expect(page.getByTestId('decline-record')).toContainText('Staff');
		await expect(page.getByTestId('decline-record')).toContainText(
			'602df298-8d54-45b6-a40c-bbf80949a3b8'
		);
		await expect(page.getByTestId('request-summary')).not.toContainText(
			/Needs a quote|deposit|On the calendar|Served|Event closed/
		);
		await expect(page.getByTestId('request-summary')).toContainText('Declined estimate');
		for (const id of [
			'build-quote',
			'decline-request',
			'quote-builder',
			'decline-form',
			'open-payment',
			'payment-form',
			'fulfillment-form'
		])
			await expect(page.getByTestId(id)).toHaveCount(0);
	}
	const response = await postAction(page, `${route}?/declineInquiry`, {
		expectedDocumentVersion: '2',
		reason: 'Again'
	});
	expect(response.status).toBe(409);
	expect(response.data).toContain('changed or has already been handled');
	const state = await session(context);
	expect(state.declineAttempts).toEqual([]);
	expect(state.previewAttempts).toEqual([]);
});
