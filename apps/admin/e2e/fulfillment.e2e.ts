import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mayaId, paymentFixture, appendPayment } from './request-fixture.mjs';

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
async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('User').fill('brayan');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/$/);
}
function fixture(state: 'booked' | 'served' | 'settled' | 'credit' | 'closed' = 'booked') {
	const request = paymentFixture(state === 'booked' ? 'booked' : 'served');
	const future = new Date();
	future.setUTCFullYear(future.getUTCFullYear() + 1);
	request.inquiry.eventDate = future.toISOString().slice(0, 10);
	if (state !== 'booked')
		request.inquiry.lifecycle.served = {
			occurredAt: '2026-10-06T23:42:00Z',
			principalKind: 'USER',
			principalId: 'staff'
		};
	if (['settled', 'credit', 'closed'].includes(state))
		appendPayment(request, state === 'credit' ? '120.00' : '115.00', 'CHECK', 3);
	if (state === 'closed') {
		request.inquiry.lifecycle.stage = 'CLOSED';
		request.inquiry.lifecycle.closed = {
			occurredAt: '2026-10-07T00:18:00Z',
			principalKind: 'USER',
			principalId: 'staff'
		};
	}
	return request;
}
async function open(
	page: Page,
	context: BrowserContext,
	state: Parameters<typeof fixture>[0] = 'booked'
) {
	await session(context, { request: fixture(state) });
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

for (const native of [false, true])
	test.describe(native ? 'native fulfillment' : 'enhanced fulfillment', () => {
		test.use({ javaScriptEnabled: !native });
		test('future BOOKED → unpaid SERVED → final payment → CLOSED via clean authoritative GETs', async ({
			page,
			context
		}, testInfo) => {
			if (testInfo.project.name === 'desktop-chromium')
				await page.setViewportSize({ width: 1444, height: 1600 });
			await open(page, context);
			await expect(page.getByRole('button', { name: 'Mark event served' })).toBeVisible();
			await expect(page.getByTestId('payment-form')).toBeVisible();
			await expect(page.getByTestId('fulfillment-form').locator('[name]')).toHaveCount(0);
			await noOverflow(page);
			await page.screenshot({ path: testInfo.outputPath('booked.png'), fullPage: true });
			const before = await session(context);
			const response = page.waitForResponse(
				(r) => r.request().method() === 'POST' && r.url().includes('markServed')
			);
			await page.getByRole('button', { name: 'Mark event served' }).click();
			expect((await response).status()).toBe(native ? 303 : 200);
			await expect(page).toHaveURL(route);
			await expect(page.getByTestId('request-summary')).toContainText('Event served');
			await expect(page.locator('[aria-current="step"]')).toHaveText('Served');
			await expect(page.getByTestId('request-summary')).toContainText(
				'Marked served Oct 6, 2026, 4:42 PM'
			);
			await expect(page.getByRole('button', { name: 'Close event' })).toHaveCount(0);
			await expect(page.getByTestId('payment-form')).toContainText('Invoice balance: $115');
			const served = await session(context);
			expect(served.requestReads - before.requestReads).toBe(2);
			expect(served.fulfillmentAttempts).toEqual([
				{ inquiryId: mayaId, operation: 'served', body: '' }
			]);
			expect(served.requests[mayaId].financial).toEqual(before.requests[mayaId].financial);
			expect(served.requests[mayaId].payments).toEqual(before.requests[mayaId].payments);
			await noOverflow(page);
			await page.getByTestId('request-summary').scrollIntoViewIfNeeded();
			await page.screenshot({
				path: testInfo.outputPath('served-outstanding.png'),
				fullPage: true
			});
			await page.getByLabel('Payment amount (USD)').fill('115.00');
			await page.getByLabel('Payment method').selectOption('CHECK');
			await page.getByRole('button', { name: 'Record payment', exact: true }).click();
			await expect(page).toHaveURL(route);
			await expect(page.getByTestId('request-summary')).toContainText('Event served');
			await expect(page.getByTestId('request-summary')).toContainText('Balance: $0');
			await expect(page.getByRole('button', { name: 'Close event' })).toBeEnabled();
			await expect(page.getByTestId('payment-form')).toHaveCount(0);
			await noOverflow(page);
			await page.getByTestId('request-summary').scrollIntoViewIfNeeded();
			await page.screenshot({ path: testInfo.outputPath('served-settled.png'), fullPage: true });
			await page.getByRole('button', { name: 'Close event' }).click();
			await expect(page).toHaveURL(route);
			await expect(page.getByTestId('request-summary')).toContainText('Event closed');
			await expect(page.locator('[aria-current="step"]')).toHaveText('Closed');
			await expect(page.getByTestId('request-summary')).toContainText(
				'Closed Oct 6, 2026, 5:18 PM'
			);
			await expect(page.getByTestId('fulfillment-form')).toHaveCount(0);
			await expect(page.getByTestId('payment-form')).toHaveCount(0);
			await expect(page.getByTestId('payment-receipt')).toHaveCount(2);
			await expect(page.getByRole('heading', { name: 'Serving plan' })).toBeVisible();
			await noOverflow(page);
			await page.getByTestId('request-summary').scrollIntoViewIfNeeded();
			await page.screenshot({ path: testInfo.outputPath('closed.png'), fullPage: true });
			await page.reload();
			expect((await session(context)).fulfillmentAttempts).toHaveLength(2);
		});
		test('SERVED credit blocks close and retains exact negative balance/history', async ({
			page,
			context
		}) => {
			await open(page, context, 'credit');
			await expect(page.getByTestId('request-summary')).toContainText('Balance: -$5');
			await expect(page.getByTestId('request-summary')).toContainText('must be exactly zero');
			await expect(page.getByRole('button', { name: 'Close event' })).toHaveCount(0);
			await expect(page.getByTestId('payment-form')).toHaveCount(0);
			await expect(page.getByTestId('payment-receipt')).toHaveCount(2);
			await noOverflow(page);
		});
		test('unavailable pre-mutation read requires reload without claiming an ambiguous commit', async ({
			page,
			context
		}) => {
			await open(page, context);
			await session(context, { mode: 'request-unavailable' });
			await page.getByRole('button', { name: 'Mark event served' }).click();
			await expect(page.getByRole('alert')).toContainText(
				'couldn’t review the latest request state'
			);
			await expect(page.getByRole('link', { name: 'Reload to review' })).toBeVisible();
			await expect(page.getByText('couldn’t confirm whether', { exact: false })).toHaveCount(0);
			await expect(page.getByText('PRIVATE', { exact: false })).toHaveCount(0);
			expect((await session(context)).fulfillmentAttempts).toHaveLength(0);
		});
		for (const close of [false, true]) {
			test(`${close ? 'close' : 'serve'} commit then 500 blocks all mutations until reload`, async ({
				page,
				context
			}) => {
				await open(page, context, close ? 'settled' : 'booked');
				await session(context, { mode: 'fulfillment-ambiguous' });
				await page
					.getByRole('button', { name: close ? 'Close event' : 'Mark event served' })
					.click();
				await expect(page.getByRole('alert')).toContainText(
					`couldn’t confirm whether the event was ${close ? 'closed' : 'marked served'}`
				);
				for (const button of await page
					.locator('[data-testid="fulfillment-form"] button, [data-testid="payment-form"] button')
					.all())
					await expect(button).toBeDisabled();
				expect((await session(context)).fulfillmentAttempts).toHaveLength(1);
				await page.getByRole('link', { name: 'Reload to review' }).click();
				await expect(page).toHaveURL(route);
				await expect(page.getByTestId('request-summary')).toContainText(
					close ? 'Event closed' : 'Event served'
				);
				if (!close)
					await expect(
						page.getByRole('button', { name: 'Record payment', exact: true })
					).toBeEnabled();
				expect((await session(context)).fulfillmentAttempts).toHaveLength(1);
			});
			test(`${close ? 'close' : 'serve'} stale re-read prevents mutation and blocks controls`, async ({
				page,
				context
			}) => {
				await open(page, context, close ? 'settled' : 'booked');
				await session(context, { request: fixture('served') });
				await page
					.getByRole('button', { name: close ? 'Close event' : 'Mark event served' })
					.click();
				await expect(page.getByRole('alert')).toContainText('changed since you opened it');
				for (const button of await page
					.locator('[data-testid="fulfillment-form"] button, [data-testid="payment-form"] button')
					.all())
					await expect(button).toBeDisabled();
				expect((await session(context)).fulfillmentAttempts).toHaveLength(0);
			});
		}
		test('ambiguous payment also blocks fulfillment until reload', async ({ page, context }) => {
			await open(page, context);
			await session(context, { mode: 'payment-ambiguous' });
			await page.getByLabel('Payment amount (USD)').fill('15.00');
			await page.getByRole('button', { name: 'Record payment', exact: true }).click();
			await expect(page.getByRole('alert')).toContainText(
				'couldn’t confirm whether the payment was recorded'
			);
			await expect(page.getByRole('button', { name: 'Mark event served' })).toBeDisabled();
			expect((await session(context)).fulfillmentAttempts).toHaveLength(0);
		});
	});

test('payment permission never authorizes fulfillment; direct POST denied before workspace read', async ({
	page,
	context
}) => {
	for (const state of ['booked', 'settled'] as const) {
		await session(context, {
			request: fixture(state),
			permissions: [
				'fionas.inquiries.read',
				'commerce.financial-document.read',
				'commerce.payment.record'
			]
		});
		await page.goto(route);
		await expect(page.getByTestId('fulfillment-form')).toHaveCount(0);
		if (state === 'booked')
			await expect(page.getByRole('button', { name: 'Record payment', exact: true })).toBeVisible();
		const before = await session(context);
		const response = await context.request.post(
			`${route}?/${state === 'booked' ? 'markServed' : 'closeInquiry'}`,
			{ form: {}, headers: { accept: 'application/json', 'x-sveltekit-action': 'true' } }
		);
		expect(response.status()).toBe(403);
		const after = await session(context);
		expect(after.fulfillmentAttempts).toHaveLength(0);
		expect(after.requestReads - before.requestReads).toBe(0);
	}
});
test('fulfillment permission never authorizes payments', async ({ page, context }) => {
	await session(context, {
		request: fixture(),
		permissions: [
			'fionas.inquiries.read',
			'commerce.financial-document.read',
			'fionas.inquiries.manage'
		]
	});
	await page.goto(route);
	await expect(page.getByTestId('payment-form')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Mark event served' })).toBeEnabled();
	await page.getByRole('button', { name: 'Mark event served' }).click();
	await expect(page.getByTestId('request-summary')).toContainText('Event served');
	await expect(page.getByTestId('payment-form')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Close event' })).toHaveCount(0);
});

test('enhanced submission disables both controls and prevents a duplicate POST', async ({
	page,
	context
}) => {
	await open(page, context);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route('**/*markServed*', async (route) => {
		await gate;
		await route.continue();
	});
	const form = page.getByTestId('fulfillment-form');
	await page.getByRole('button', { name: 'Mark event served' }).click();
	await expect(page.getByRole('button', { name: 'Marking served…' })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Record payment', exact: true })).toBeDisabled();
	await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
	release();
	await expect(page.getByTestId('request-summary')).toContainText('Event served');
	await page.unroute('**/*markServed*');
	expect((await session(context)).fulfillmentAttempts).toHaveLength(1);
});
