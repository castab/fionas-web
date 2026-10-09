import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { fillContact, fillService, sendButton, submissionFor, deliveriesFor } from './form.js';

/*
 * /book publishes to a real NATS + JetStream (e2e/global-setup.ts) and these specs read back what
 * was stored. Unknown and refused deliveries (lost acknowledgements, no stream, denied publish)
 * can't be produced on demand against a real server, so they are covered by the unit tests
 * (src/lib/server/booking-page.test.ts and event-bus.test.ts).
 */

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
			const [delivery] = await deliveriesFor(email);
			expect(delivery.msgID).toBe(key);
			expect(delivery.event).toMatchObject({
				schemaVersion: 1,
				type: 'fionas.inquiry.submitted',
				source: 'fionas-web',
				data: { priceRevision: 'synthetic-1', message: 'Backyard birthday' }
			});
			const body = delivery.event.data;
			expect(body.requestedService.guestCount).toBe(75);
			expect(body.requestedService).not.toHaveProperty('durationMinutes');
			expect(body.requestedService.items).toEqual(
				expect.arrayContaining([
					{ label: 'Chocolate Chip', group: 'Hand-scooped', key: 'hand-scooped-chocolate-chip' },
					{ label: 'Butter Pecan', group: 'Hand-scooped', key: 'hand-scooped-butter-pecan' },
					{ label: 'Sugar Cones', group: 'Cones & cups', key: 'sugar-cone' },
					{ label: 'Cups', group: 'Cones & cups', key: 'cup' }
				])
			);
			expect(JSON.stringify(body)).not.toMatch(/soft.serve/i);
			expect(body.lines).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ unitPrice: '101.00' }),
					expect.objectContaining({ quantity: '75', unitPrice: '7.00' })
				])
			);
			// Free flavors, cones and cups, in any combination, never add a priced line.
			expect(body.lines.map((l) => l.description)).not.toEqual(
				expect.arrayContaining([expect.stringMatching(/cone|cup|butter/i)])
			);
			expect(body).not.toHaveProperty('total');
			expect(body).not.toHaveProperty('pricingInputs');
			await page.reload();
			expect(await deliveriesFor(email)).toHaveLength(1);
		});
	});
test('server ignores forged financial fields and alternate service labels', async ({ page }) => {
	const email = `tamper-${randomUUID()}@example.com`;
	await page.goto('/book');
	await fillContact(page, email);
	await fillService(page);
	await page.locator('main form').evaluate((form) => {
		for (const name of ['unitPrice', 'total', 'lines', 'requestedService', 'id']) {
			const input = document.createElement('input');
			input.type = 'hidden';
			input.name = name;
			input.value = 'FORGED_PRICE';
			form.append(input);
		}
	});
	await sendButton(page).click();
	await expect(page).toHaveURL(/\/received$/);
	expect(JSON.stringify((await deliveriesFor(email))[0].event)).not.toContain('FORGED_PRICE');
});
test('a changed revision requires review before any delivery', async ({ page }) => {
	const email = `revision-${randomUUID()}@example.com`;
	await page.goto('/book');
	await fillContact(page, email);
	await fillService(page);
	await page.locator('[name=priceRevision]').evaluate((el: HTMLInputElement) => (el.value = 'old'));
	await sendButton(page).click();
	await expect(page.getByRole('button', { name: 'Send booking request' })).toBeVisible();
	expect(await submissionFor(email)).toBeUndefined();
});
test('a forged replay is refused without publishing', async ({ page, baseURL }) => {
	await page.goto('/book');
	const key = await page.locator('[name=submissionToken]').inputValue();
	const response = await page.request.post('/book', {
		headers: { origin: baseURL!, accept: 'text/html' },
		form: {
			submissionToken: key,
			priceRevision: 'synthetic-1',
			outcomeUnknown: 'true',
			replayRequest: JSON.stringify({ data: { email: 'forged@example.com', lines: [] } })
		},
		maxRedirects: 0
	});
	expect(response.status()).toBe(400);
	expect(await response.text()).toMatch(/couldn.t safely resend/);
	expect((await deliveriesFor('forged@example.com')).length).toBe(0);
});
