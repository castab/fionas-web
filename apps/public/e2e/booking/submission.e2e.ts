import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
	attemptsFor,
	fillContact,
	fillService,
	sendButton,
	stub,
	submissionFor,
	submissionsFor
} from './form.js';

/*
 * The real path: browser → SvelteKit (production build) → stub fionas-commerce over HTTP. The stub
 * keeps the Idempotency-Key contract and records every POST /inquiries the server made.
 */

const STUB_KEY = 'e2e-ui-key';

const emailFor = (scenario: string) => `${scenario}-${randomUUID()}@example.com`;

async function fillAll(page: Page, email: string) {
	await page.goto('/book');
	await fillContact(page, email);
	await fillService(page);
}

const receivedCard = (page: Page) => page.getByRole('status');

test('submits through the server with one key and shows the receipt', async ({ page, baseURL }) => {
	const email = emailFor('priced');
	const browserRequests: string[] = [];
	page.on('request', (r) => browserRequests.push(r.url()));

	await fillAll(page, email);
	const token = await page.locator('input[name="submissionToken"]').inputValue();
	expect(token).toMatch(/^[0-9a-f-]{36}$/);
	await sendButton(page).click();

	await expect(page).toHaveURL(/\/book\/received$/);
	await expect(receivedCard(page)).toContainText('we got your request');
	await expect(receivedCard(page)).toContainText('not a booking');
	expect(await attemptsFor(page, email)).toEqual([{ email, key: token, authorized: true }]);

	const submission = await submissionFor(page, email);
	expect(submission?.pricingInputs?.catalogRevision).toBe(15);
	// Intent only: the server never forwards browser-side figures.
	expect(JSON.stringify(submission)).not.toMatch(/total|subtotal|lines|amount/i);

	// The browser only ever talked to the site itself, never to fionas-commerce.
	expect(browserRequests.every((url) => url.startsWith(baseURL!))).toBe(true);
	expect(browserRequests.some((url) => url.startsWith(stub))).toBe(false);

	// Reloading the confirmation re-posts nothing.
	await page.reload();
	await expect(receivedCard(page)).toContainText('we got your request');
	expect(await attemptsFor(page, email)).toHaveLength(1);
});

test('a lost response is retried with the same key and recorded once', async ({ page }) => {
	const email = emailFor('lost');
	await fillAll(page, email);
	const token = await page.locator('input[name="submissionToken"]').inputValue();
	await sendButton(page).click();

	await expect(page).toHaveURL(/\/book\/received$/);
	expect((await attemptsFor(page, email)).map((a) => a.key)).toEqual([token, token]);
	expect(await submissionsFor(page, email)).toHaveLength(1);
});

test('an outage leaves a recoverable form that resends under the same key', async ({ page }) => {
	const email = emailFor('down');
	await fillAll(page, email);
	const token = await page.locator('input[name="submissionToken"]').inputValue();
	await sendButton(page).click();

	await expect(page.getByRole('alert')).toContainText("couldn't confirm your request was sent");
	await expect(page.getByLabel('Your name')).toHaveValue('Jane Doe');
	await expect(page.getByText('diagnostic')).toHaveCount(0);
	expect((await attemptsFor(page, email)).map((a) => a.key)).toEqual([token, token]);

	await sendButton(page).click();
	await expect(page).toHaveURL(/\/book\/received$/);
	expect((await attemptsFor(page, email)).map((a) => a.key)).toEqual([token, token, token]);
	expect(await submissionsFor(page, email)).toHaveLength(1);
});

test('a catalog change asks for review and sends the reviewed form as a new submission', async ({
	page
}) => {
	const email = emailFor('stale');
	await fillAll(page, email);
	await page.getByLabel('Tell us about your event').fill('Backyard party');
	const token = await page.locator('input[name="submissionToken"]').inputValue();
	await sendButton(page).click();

	const notice = page.getByRole('alert').filter({ hasText: 'Our menu changed' });
	await expect(notice).toBeVisible();
	await expect(notice).toContainText('Choose your soft serve flavors');
	await expect(page).toHaveURL(/\/book$/);

	// Customer details survive; the retired flavor is gone rather than swapped for another.
	await expect(page.getByLabel('Your name')).toHaveValue('Jane Doe');
	await expect(page.getByLabel('ZIP code')).toHaveValue('02134');
	await expect(page.getByLabel('Tell us about your event')).toHaveValue('Backyard party');
	await expect(page.getByRole('checkbox', { name: 'Horchata' })).toHaveCount(0);
	await expect(page.getByRole('checkbox', { name: 'Vanilla' })).toBeChecked();
	await expect(page.locator('input[name="catalogRevision"]')).toHaveValue('16');
	const reviewedToken = await page.locator('input[name="submissionToken"]').inputValue();
	expect(reviewedToken).not.toBe(token);

	// Nothing was resubmitted on the customer's behalf.
	expect(await attemptsFor(page, email)).toHaveLength(1);

	await sendButton(page).click();
	await expect(page).toHaveURL(/\/book\/received$/);
	expect((await attemptsFor(page, email)).map((a) => a.key)).toEqual([token, reviewedToken]);
	const submission = await submissionFor(page, email);
	expect(submission?.pricingInputs?.catalogRevision).toBe(16);
	expect(submission?.pricingInputs?.selections[0]).toEqual({
		category: 'soft-serve-flavor',
		offerings: ['vanilla']
	});
});

test('a reused key is not retried behind the customer’s back', async ({ page }) => {
	const email = emailFor('reused');
	await fillAll(page, email);
	const token = await page.locator('input[name="submissionToken"]').inputValue();
	await sendButton(page).click();

	const alert = page.getByRole('alert');
	await expect(alert).toContainText("doesn't match the one this page already sent us");
	await expect(page.getByText('diagnostic')).toHaveCount(0);
	expect((await attemptsFor(page, email)).map((a) => a.key)).toEqual([token]);

	await alert.getByRole('button', { name: 'Send as a new request' }).click();
	await expect(page).toHaveURL(/\/book\/received$/);
	const keys = (await attemptsFor(page, email)).map((a) => a.key);
	expect(keys).toHaveLength(2);
	expect(keys[0]).toBe(token);
	expect(keys[1]).not.toBe(token);
});

test('a backend validation failure is shown as a form problem', async ({ page }) => {
	const email = emailFor('invalid');
	await fillAll(page, email);
	await sendButton(page).click();

	await expect(page.getByRole('alert')).toContainText("guest count isn't something we can price");
	await expect(page.getByText('diagnostic')).toHaveCount(0);
	await expect(page).toHaveURL(/\/book$/);
});

test('a duplicated delivery of one submission records one inquiry', async ({ page, baseURL }) => {
	const email = emailFor('double');
	await page.goto('/book');
	const token = await page.locator('input[name="submissionToken"]').inputValue();

	// What the browser would post for this form, delivered twice at once (no JavaScript involved).
	const body = new URLSearchParams([
		['submissionToken', token],
		['catalogRevision', '15'],
		['name', 'Jane Doe'],
		['email', email],
		['zipCode', '02134'],
		['eventDate', '2026-12-05'],
		['eventType', 'BIRTHDAY'],
		['guestCount', '75'],
		['durationMinutes', '120'],
		['offering:soft-serve-flavor', 'vanilla'],
		['offering:topping', 'sprinkles'],
		['offering:topping', 'oreos'],
		['offering:topping', 'strawberries'],
		['offering:topping', 'brownies'],
		['offering:cone-option', 'cup']
	]).toString();
	const deliver = () =>
		page.request.post('/book', {
			data: body,
			// A plain browser form post: HTML expected back, same-origin.
			headers: {
				accept: 'text/html',
				'content-type': 'application/x-www-form-urlencoded',
				origin: baseURL!
			},
			maxRedirects: 0
		});
	const responses = await Promise.all([deliver(), deliver()]);

	for (const response of responses) {
		expect(response.status()).toBe(303);
		expect(response.headers().location).toBe('/book/received');
	}
	expect((await attemptsFor(page, email)).map((a) => a.key)).toEqual([token, token]);
	expect(await submissionsFor(page, email)).toHaveLength(1);
});

test('nothing the browser receives carries the commerce credential or address', async ({
	page
}) => {
	const pages = [
		await (await page.request.get('/book')).text(),
		await (await page.request.get('/book/__data.json')).text()
	];
	for (const text of pages) {
		expect(text).toContain('submissionToken');
		expect(text).not.toContain(STUB_KEY);
		expect(text).not.toContain('Bearer');
		expect(text).not.toContain(stub);
		expect(text).not.toMatch(/COMMERCE_(UI_API_KEY|API_URL)/);
	}

	// The client build holds no private configuration either.
	const files = (dir: string): string[] =>
		readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
			e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]
		);
	const client = files(join(process.cwd(), 'build', 'client')).filter((f) =>
		/\.(js|html)$/.test(f)
	);
	expect(client.length).toBeGreaterThan(0);
	for (const file of client) {
		const text = readFileSync(file, 'utf8');
		expect(text, file).not.toMatch(/COMMERCE_UI_API_KEY|COMMERCE_API_URL|e2e-ui-key/);
	}
});
