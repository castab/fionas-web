import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { fillContact, fillService, sendButton, submissionFor, attemptsFor } from './form.js';
for (const native of [false, true])
	test.describe(`submission native=${native}`, () => {
		test.use({ javaScriptEnabled: !native });
		test(`configured service, exact prices and receipt; native=${native}`, async ({ page }) => {
			const email = `priced-${randomUUID()}@example.com`;
			await page.goto('/book');
			await fillContact(page, email);
			await fillService(page);
			await page.getByLabel('Anything else?').fill('Backyard birthday');
			const key = await page.locator('[name=submissionToken]').inputValue();
			await sendButton(page).click();
			await expect(page).toHaveURL(/\/book\/received$/);
			await expect(page.getByRole('status')).toContainText('Request received');
			const body = await submissionFor(page, email);
			expect(body?.requestedService.guestCount).toBe(75);
			expect(body?.requestedService.items).toEqual(
				expect.arrayContaining([
					{ label: 'Horchata', group: 'Soft serve', key: 'horchata' },
					{ label: 'Chocolate Chip', group: 'Hand-scooped', key: 'hand-scooped-chocolate-chip' },
					{ label: 'Waffle cone', group: 'Cones & cups', key: 'waffle-cone' }
				])
			);
			expect(body?.lines).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ unitPrice: '141.00' }),
					expect.objectContaining({ quantity: '75', unitPrice: '7.00' })
				])
			);
			expect(body).not.toHaveProperty('total');
			expect(body).not.toHaveProperty('pricingInputs');
			expect((await attemptsFor(page, email))[0].key).toBe(key);
			await page.reload();
			expect((await attemptsFor(page, email)).length).toBe(1);
		});
	});
test('server ignores forged financial fields and alternate service labels', async ({ page }) => {
	const email = `tamper-${randomUUID()}@example.com`;
	await page.goto('/book');
	await fillContact(page, email);
	await fillService(page);
	await page.locator('main form').evaluate((form) => {
		for (const name of ['unitPrice', 'total', 'lines', 'requestedService']) {
			const input = document.createElement('input');
			input.type = 'hidden';
			input.name = name;
			input.value = 'FORGED_PRICE';
			form.append(input);
		}
	});
	await sendButton(page).click();
	await expect(page).toHaveURL(/\/received$/);
	expect(JSON.stringify(await submissionFor(page, email))).not.toContain('FORGED_PRICE');
});
test('a changed revision requires review before any delivery', async ({ page }) => {
	const email = `revision-${randomUUID()}@example.com`;
	await page.goto('/book');
	await fillContact(page, email);
	await fillService(page);
	await page.locator('[name=priceRevision]').evaluate((el: HTMLInputElement) => (el.value = 'old'));
	await sendButton(page).click();
	await expect(page.getByRole('button', { name: 'Send booking request' })).toBeVisible();
	expect(await attemptsFor(page, email)).toHaveLength(0);
	expect(await submissionFor(page, email)).toBeUndefined();
});
test('unknown deliveries freeze answers and replay exactly once under the same key', async ({
	page
}) => {
	const email = `hidden500-${randomUUID()}@example.com`;
	await page.goto('/book');
	await fillContact(page, email);
	await fillService(page);
	await sendButton(page).click();
	await expect(page.getByRole('button', { name: 'Try sending again' })).toBeVisible();
	expect(await attemptsFor(page, email)).toHaveLength(2);
	const key = (await attemptsFor(page, email))[0].key;
	await page.getByRole('button', { name: 'Try sending again' }).click();
	await expect(page).toHaveURL(/\/received$/);
	expect((await attemptsFor(page, email)).every((a) => a.key === key)).toBe(true);
});
test('forged replay cannot send trusted lines', async ({ page }) => {
	const email = `down-${randomUUID()}@example.com`;
	await page.goto('/book');
	await fillContact(page, email);
	await fillService(page);
	await sendButton(page).click();
	await expect(page.getByRole('button', { name: 'Try sending again' })).toBeVisible();
	await page
		.locator('[name=replayRequest]')
		.evaluate((el: HTMLInputElement) => (el.value = 'unsigned'));
	await page.getByRole('button', { name: 'Try sending again' }).click();
	expect(await attemptsFor(page, email)).toHaveLength(2);
	await expect(page.getByText(/couldn.t safely resend/)).toBeVisible();
});
