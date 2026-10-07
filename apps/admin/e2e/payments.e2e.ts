import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mayaId, mayaDocumentId, paymentFixture, appendPayment } from './request-fixture.mjs';

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
async function open(
	page: Page,
	context: BrowserContext,
	state: Parameters<typeof paymentFixture>[0] = 'quoted'
) {
	await session(context, { request: paymentFixture(state) });
	await page.goto(route);
}
async function noOverflow(page: Page) {
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		)
	).toBeLessThanOrEqual(0);
}
test.beforeEach(async ({ page }) => {
	await signIn(page);
});

test('a backend credit balance remains readable with its full history and no payment action', async ({
	page,
	context
}) => {
	const request = paymentFixture('booked');
	appendPayment(request, '115.01', 'CHECK', 3);
	await session(context, { request });
	await page.goto(route);
	await expect(page.getByTestId('request-summary')).toContainText('Balance: -$0.01');
	await expect(page.getByTestId('payment-receipt')).toHaveCount(2);
	await expect(page.getByTestId('payment-form')).toHaveCount(0);
});

for (const native of [false, true]) {
	test.describe(native ? 'native manual payments' : 'enhanced manual payments', () => {
		test.use({ javaScriptEnabled: !native });
		test('exact deposit books, then separate additional payment; clean GETs preserve historical allocation', async ({
			page,
			context
		}, testInfo) => {
			if (testInfo.project.name === 'desktop-chromium')
				await page.setViewportSize({ width: 1444, height: 1145 });
			const before = await session(context);
			await open(page, context);
			const afterRead = await session(context);
			expect(afterRead.requestReads - before.requestReads).toBe(1);
			expect(afterRead.readPaths.slice(before.readPaths.length)).toEqual([
				'/auth/me',
				`/staff/requests/${mayaId}`
			]);
			await expect(page.getByTestId('deposit-summary')).toContainText('$300');
			await expect(page.getByTestId('payment-form')).toContainText('Must be recorded in full');
			await expect(
				page.getByTestId('payment-form').locator('input:not([type=hidden])')
			).toHaveCount(0);
			await expect(page.getByLabel('Payment method').locator('option')).toHaveText([
				'Cash',
				'Check',
				'Other'
			]);
			await noOverflow(page);
			await page.screenshot({ path: testInfo.outputPath('quoted-payments.png'), fullPage: true });
			const post = page.waitForResponse(
				(response) =>
					response.request().method() === 'POST' && response.url().includes('recordDeposit')
			);
			await page.getByLabel('Payment method').selectOption('CASH');
			await page.getByRole('button', { name: 'Record $300 deposit' }).click();
			expect((await post).status()).toBe(native ? 303 : 200);
			await expect(page).toHaveURL(route);
			await expect(page.getByTestId('request-summary')).toContainText('Event booked');
			await expect(page.getByTestId('financial-document')).toContainText('Invoice');
			await expect(page.getByTestId('financial-document')).toContainText('Version 3');
			await expect(page.getByTestId('payment-history')).toContainText('$300 received · Cash');
			await expect(page.getByTestId('payment-history')).toContainText(
				'Booking deposit · Originally allocated $300 to Quote version 2'
			);
			await expect(page.getByTestId('payment-form')).toContainText('Invoice balance: $115');
			expect((await session(context)).paymentAttempts).toEqual([
				{
					documentId: mayaDocumentId,
					body: {
						documentVersion: 2,
						amount: '300.00',
						method: 'CASH',
						expectedProposalId: paymentFixture().proposal!.id
					}
				}
			]);
			await page.getByLabel('Payment amount (USD)').fill('100.00');
			await page.getByRole('button', { name: 'Record payment', exact: true }).click();
			await expect(page).toHaveURL(route);
			await expect(page.getByTestId('request-summary')).toContainText('Event booked');
			await expect(page.getByTestId('payment-form')).toContainText('Invoice balance: $15');
			await expect(page.getByLabel('Payment amount (USD)')).toHaveValue('');
			await expect(page.getByTestId('payment-receipt')).toHaveCount(2);
			await expect(page.getByTestId('payment-history')).toContainText('$100 received · Cash');
			await noOverflow(page);
			await page.screenshot({ path: testInfo.outputPath('booked-payments.png'), fullPage: true });
			await page.getByTestId('payment-history').scrollIntoViewIfNeeded();
			await page.screenshot({ path: testInfo.outputPath('payment-history.png'), fullPage: true });
			await page.reload();
			const after = await session(context);
			expect(after.paymentAttempts).toHaveLength(2);
			expect(after.paymentAttempts[1].body).toEqual({
				documentVersion: 3,
				amount: '100.00',
				method: 'CASH'
			});
			expect(after.requests[mayaId].depositRequirement.satisfied).toBe(true);
			expect(after.requests[mayaId].financial.reconciliation).toMatchObject({
				balance: '15.00',
				netApplied: '400.00'
			});
			expect(after.requests[mayaId].payments[0].allocations[0].documentVersion).toBe(2);
		});
		test('stale proposal and version require review without retargeting', async ({
			page,
			context
		}) => {
			await open(page, context);
			const newer = paymentFixture();
			newer.proposal!.id = '30000000-0000-0000-0000-000000000099';
			newer.proposal!.documentVersion = 3;
			newer.financial.version = 3;
			if (newer.depositRequirement.state === 'ACTIVE')
				newer.depositRequirement.approvalDocumentVersion = 3;
			await session(context, { request: newer });
			await page.getByRole('button', { name: 'Record $300 deposit' }).click();
			await expect(page.getByRole('alert')).toContainText('Reload to review');
			await expect(page.getByRole('button', { name: 'Record $300 deposit' })).toBeDisabled();
			expect((await session(context)).paymentAttempts).toHaveLength(0);
			await page.getByRole('link', { name: 'Reload to review' }).click();
			await expect(page.getByRole('button', { name: 'Record $300 deposit' })).toBeEnabled();
		});
		test('invalid Invoice amount cannot mutate, then an exact corrected amount succeeds', async ({
			page,
			context
		}) => {
			await open(page, context, 'booked');
			const input = page.getByLabel('Payment amount (USD)');
			for (const amount of ['0', '115.01', '100.001']) {
				await input.fill(amount);
				await page.getByRole('button', { name: 'Record payment', exact: true }).click();
				if (native) {
					await expect(page.getByRole('alert')).toContainText('Enter a valid payment');
					await expect(input).toHaveValue(amount);
					await expect(input).toHaveAttribute('aria-invalid', 'true');
				} else
					expect(await input.evaluate((element: HTMLInputElement) => element.checkValidity())).toBe(
						false
					);
				expect((await session(context)).paymentAttempts).toHaveLength(0);
			}
			await input.fill('115.00');
			await page.getByRole('button', { name: 'Record payment', exact: true }).click();
			await expect(page.getByTestId('payment-form')).toHaveCount(0);
			await expect(page.getByTestId('request-summary')).toContainText('Event booked');
			expect((await session(context)).paymentAttempts).toHaveLength(1);
		});
		for (const state of ['quoted', 'booked'] as const) {
			test(`${state} commit then 500 blocks replay; reload reveals payment`, async ({
				page,
				context
			}) => {
				await open(page, context, state);
				await session(context, { mode: 'payment-ambiguous' });
				if (state === 'booked') await page.getByLabel('Payment amount (USD)').fill('100.00');
				await page
					.getByRole('button', {
						name: state === 'quoted' ? 'Record $300 deposit' : 'Record payment',
						exact: true
					})
					.click();
				await expect(page.getByRole('alert')).toContainText(
					'couldn’t confirm whether the payment was recorded'
				);
				await expect(page.getByTestId('payment-form').getByRole('button')).toBeDisabled();
				expect((await session(context)).paymentAttempts).toHaveLength(1);
				await page.getByRole('link', { name: 'Reload to review' }).click();
				await expect(page).toHaveURL(route);
				await expect(page.getByTestId('request-summary')).toContainText('Event booked');
				await expect(page.getByTestId('payment-receipt')).toHaveCount(state === 'quoted' ? 1 : 2);
				expect((await session(context)).paymentAttempts).toHaveLength(1);
			});
		}
		test('Invoice accepts partial Check/Other and hides controls when paid; SERVED stays served', async ({
			page,
			context
		}) => {
			await open(page, context, 'served');
			await page.getByLabel('Payment amount (USD)').fill('15.00');
			await page.getByLabel('Payment method').selectOption('CHECK');
			await page.getByRole('button', { name: 'Record payment', exact: true }).click();
			await expect(page.getByTestId('request-summary')).toContainText('Event served');
			await expect(page.getByTestId('payment-form')).toContainText('Invoice balance: $100');
			await page.getByLabel('Payment amount (USD)').fill('100');
			await page.getByLabel('Payment method').selectOption('OTHER');
			await page.getByRole('button', { name: 'Record payment', exact: true }).click();
			await expect(page.getByTestId('payment-form')).toHaveCount(0);
			await expect(page.getByTestId('request-summary')).toContainText('Event served');
			await expect(page.getByTestId('payment-history')).toContainText('$15 received · Check');
			await expect(page.getByTestId('payment-history')).toContainText('$100 received · Other');
		});
		test('Invoice stale version blocks mutation and native invalid amount needs review if projection changed', async ({
			page,
			context
		}) => {
			await open(page, context, 'booked');
			await page.getByLabel('Payment amount (USD)').fill(native ? '100.001' : '100');
			const newer = paymentFixture('booked');
			newer.financial.version = 4;
			await session(context, { request: newer });
			await page.getByRole('button', { name: 'Record payment', exact: true }).click();
			await expect(page.getByRole('alert')).toContainText('Reload');
			await expect(
				page.getByRole('button', { name: 'Record payment', exact: true })
			).toBeDisabled();
			expect((await session(context)).paymentAttempts).toHaveLength(0);
		});
	});
}

test('Administrator without payment permission sees deposit/history but no controls or permitted action', async ({
	page,
	context
}) => {
	await context.clearCookies();
	await signIn(page, 'request-no-payment');
	await open(page, context);
	await expect(page.getByTestId('deposit-summary')).toContainText('$300');
	await expect(page.getByTestId('payment-history')).toBeVisible();
	await expect(page.getByTestId('payment-form')).toHaveCount(0);
	const result = await context.request.post(`${route}?/recordDeposit`, {
		form: {
			expectedVersion: '2',
			expectedProposalId: paymentFixture().proposal!.id,
			method: 'CASH'
		}
	});
	expect(result.status()).toBe(403);
	expect((await session(context)).paymentAttempts).toHaveLength(0);
	await open(page, context, 'booked');
	await expect(page.getByTestId('payment-receipt')).toHaveCount(1);
	await expect(page.getByTestId('payment-form')).toHaveCount(0);
});
test('refunded historical deposit stays readable and never resurrects a deposit control', async ({
	page,
	context
}) => {
	await open(page, context, 'refunded');
	await expect(page.getByTestId('request-summary')).toContainText('Event booked');
	await expect(page.getByTestId('deposit-summary')).toContainText('Historical accepted deposit');
	await expect(page.getByTestId('payment-history')).toContainText('$300 received · Cash');
	await expect(page.getByTestId('payment-history')).toContainText(
		'Refunded: $300 · Net received: $0'
	);
	await expect(page.getByRole('button', { name: /Record .* deposit/ })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Record payment', exact: true })).toBeVisible();
	await noOverflow(page);
});
test('history shows only this document’s original allocation, not the whole receipt as applied here', async ({
	page,
	context
}) => {
	const data = paymentFixture('booked');
	data.payments[0].payment.amount = '400.00';
	data.payments[0].payment.method = 'constructor';
	data.payments[0].allocations.push({
		...data.payments[0].allocations[0],
		allocationId: '50000000-0000-0000-0000-000000000099',
		documentId: '10000000-0000-0000-0000-000000000099',
		amount: '100.00'
	});
	Object.assign(data.payments[0].reconciliation, {
		paymentAmount: '400.00',
		grossAllocated: '400.00',
		netReceived: '400.00',
		netAllocated: '400.00'
	});
	await session(context, { request: data });
	await page.goto(route);
	await expect(page.getByTestId('payment-history')).toContainText(
		'$400 received · Unknown payment method'
	);
	await expect(page.getByTestId('payment-history')).toContainText('Originally allocated $300');
	await expect(page.getByTestId('payment-history')).not.toContainText('Originally allocated $400');
	await expect(page.getByTestId('payment-history')).not.toContainText('Originally allocated $100');
});
for (const mode of [
	'payment-forbidden',
	'payment-not-found',
	'payment-conflict',
	'payment-invalid',
	'payment-unavailable'
]) {
	test(`${mode} blocks another submission and hides backend diagnostics`, async ({
		page,
		context
	}) => {
		await open(page, context);
		await session(context, { mode });
		await page.getByRole('button', { name: 'Record $300 deposit' }).click();
		await expect(page.getByRole('alert')).toBeVisible();
		await expect(page.getByText('PRIVATE', { exact: false })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Record $300 deposit' })).toBeDisabled();
		expect((await session(context)).paymentAttempts).toHaveLength(1);
	});
}
test('stub itself rejects partial/excess deposits and untrusted Origin without ledger writes', async ({
	context
}) => {
	await session(context, { request: paymentFixture() });
	const cookie = (await context.cookies()).map(({ name, value }) => `${name}=${value}`).join('; ');
	for (const amount of ['100.00', '299.99', '300.01', '400.00']) {
		const response = await context.request.post(
			`${stubUrl}/financial-documents/${mayaDocumentId}/payments`,
			{
				headers: {
					cookie,
					origin: `http://127.0.0.1:${process.env.ADMIN_PLAYWRIGHT_PORT ?? '4174'}`
				},
				data: {
					documentVersion: 2,
					expectedProposalId: paymentFixture().proposal!.id,
					amount,
					method: 'CASH'
				}
			}
		);
		expect(response.status()).toBe(422);
	}
	const untrusted = await context.request.post(
		`${stubUrl}/financial-documents/${mayaDocumentId}/payments`,
		{
			headers: { cookie, origin: 'http://untrusted.test' },
			data: {
				documentVersion: 2,
				expectedProposalId: paymentFixture().proposal!.id,
				amount: '300.00',
				method: 'CASH'
			}
		}
	);
	expect(untrusted.status()).toBe(403);
	expect((await session(context)).requests[mayaId].payments).toEqual([]);
});
