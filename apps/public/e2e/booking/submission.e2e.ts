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
import {
	E2E_ACCESS_TOKEN_PREFIX,
	E2E_SERVICE_CREDENTIAL,
	E2E_SERVICE_ID
} from '../test-service.js';

/*
 * The real path: browser → SvelteKit (production build) → stub fionas-commerce over HTTP. The app
 * authenticates as the stub's test SERVICE (credential → short-lived token). The stub keeps the
 * Idempotency-Key contract and records every POST /inquiries the server made.
 */

/** Anything that must never reach the browser: the service identity and the tokens it buys. */
const SECRETS = [E2E_SERVICE_CREDENTIAL, E2E_SERVICE_ID, E2E_ACCESS_TOKEN_PREFIX, 'Bearer'];

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
	// Dynamic options, one of them temporarily unavailable, and an advisory estimate before sending.
	await expect(page.getByRole('checkbox', { name: /gummy-bears/ })).toBeDisabled();
	await expect(page.getByRole('checkbox', { name: 'Vanilla', exact: true })).toBeChecked();
	await expect(page.getByText('Estimated total')).toBeVisible();
	await expect(page.getByText('Estimate only')).toBeVisible();
	const token = await page.locator('input[name="submissionToken"]').inputValue();
	expect(token).toMatch(/^[0-9a-f-]{36}$/);
	await sendButton(page).click();

	await expect(page).toHaveURL(/\/book\/received$/);
	await expect(receivedCard(page)).toContainText('Request received');
	await expect(receivedCard(page)).toContainText("Your date isn't held");
	await expect(receivedCard(page)).toContainText('Thanks, Jane —');
	await expect(page.getByRole('link', { name: 'Send another inquiry' })).toHaveAttribute(
		'href',
		'/book'
	);
	expect(await attemptsFor(page, email)).toEqual([
		{ email, key: token, token: expect.stringMatching(/^e2e-access-token-/), authorized: true }
	]);

	const submission = await submissionFor(page, email);
	expect(submission?.pricingInputs?.catalogRevision).toBe(15);
	// Intent only: the server never forwards browser-side figures.
	expect(JSON.stringify(submission)).not.toMatch(/total|subtotal|lines|amount/i);

	// The browser only ever talked to the site itself, never to fionas-commerce.
	expect(browserRequests.every((url) => url.startsWith(baseURL!))).toBe(true);
	expect(browserRequests.some((url) => url.startsWith(stub))).toBe(false);
	// No cookie holds the service credential or a token (only the receipt rides in one).
	const cookies = JSON.stringify(await page.context().cookies());
	for (const secret of SECRETS) expect(cookies).not.toContain(secret);

	// Reloading the confirmation re-posts nothing.
	await page.reload();
	await expect(receivedCard(page)).toContainText('Request received');
	expect(await attemptsFor(page, email)).toHaveLength(1);
});

test('there is no contact-only inquiry: the service must be configured first', async ({ page }) => {
	const email = emailFor('contact');
	await page.goto('/book');
	await fillContact(page, email);
	await page.getByLabel('Tell us about your event').fill('Just a question about a school fair');
	await sendButton(page).click();

	// Nothing sent; the service questions say what is missing.
	await expect(page).toHaveURL(/\/book$/);
	await expect(page.getByLabel('How many guests?')).toBeFocused();
	const service = page.getByRole('region', { name: 'Build your ice cream service' });
	await expect(service.getByText('This field is required.')).toBeVisible();
	await expect(service.getByText('Choose at least 1.')).toBeVisible();
	await expect(service.getByText('Choose at least 4.')).toBeVisible();
	await expect(service.getByText('Choose 4.', { exact: true })).toBeVisible();
	expect(await attemptsFor(page, email)).toEqual([]);

	// Completing the service makes it a real inquiry, priced by the backend.
	await fillService(page);
	await sendButton(page).click();
	await expect(page).toHaveURL(/\/book\/received$/);
	expect((await submissionFor(page, email))?.pricingInputs.guestCount).toBe(75);
});

test('a contact-only post without JavaScript is refused by the server', async ({
	page,
	baseURL
}) => {
	const email = emailFor('nojs');
	await page.goto('/book');
	const token = await page.locator('input[name="submissionToken"]').inputValue();
	const response = await page.request.post('/book', {
		form: {
			submissionToken: token,
			catalogRevision: '15',
			name: 'Jane Doe',
			email,
			zipCode: '02134',
			eventDate: '2026-12-05',
			eventType: 'BIRTHDAY',
			message: 'Contact only, please'
		},
		headers: { accept: 'text/html', origin: baseURL! },
		maxRedirects: 0
	});
	expect(response.status()).toBe(422);
	expect(await attemptsFor(page, email)).toEqual([]);
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

const retryButton = (page: Page) => page.getByRole('button', { name: 'Try sending again' });

test('an unknown outcome freezes the answers and resends them under the same key', async ({
	page
}) => {
	const email = emailFor('down');
	await fillAll(page, email);
	const token = await page.locator('input[name="submissionToken"]').inputValue();
	await sendButton(page).click();

	await expect(page.getByRole('alert')).toContainText("couldn't confirm your request was received");
	await expect(page.getByText('diagnostic')).toHaveCount(0);
	// Frozen: the exact request that may have been recorded is what goes again.
	await expect(page.locator('[data-frozen]')).toHaveAttribute('inert', '');
	await expect(page.getByLabel('Your name')).toHaveValue('Jane Doe');
	await expect(page.locator('input[name="submissionToken"]')).toHaveValue(token);
	expect((await attemptsFor(page, email)).map((a) => a.key)).toEqual([token, token]);
	// ...and the command itself travels with the page: what was delivered is what goes again.
	const replay = JSON.parse(await page.locator('input[name="replayRequest"]').inputValue());
	expect(replay).toMatchObject({ email, pricingInputs: { catalogRevision: 15 } });

	await retryButton(page).click();
	await expect(page).toHaveURL(/\/book\/received$/);
	const attempts = await attemptsFor(page, email);
	expect(attempts.map((a) => a.key)).toEqual([token, token, token]);
	expect(await submissionsFor(page, email)).toEqual([replay]);
});

test('a 500 that hid a commit freezes the answers and the retry gets the one receipt', async ({
	page
}) => {
	const email = emailFor('hidden500');
	await fillAll(page, email);
	const token = await page.locator('input[name="submissionToken"]').inputValue();
	await sendButton(page).click();

	// Two 500s: the visitor is not told it failed, nor invited to edit and resend under this key.
	await expect(page.getByRole('alert')).toContainText("couldn't confirm your request was received");
	await expect(page.locator('[data-frozen]')).toHaveAttribute('inert', '');
	await expect(page.locator('input[name="submissionToken"]')).toHaveValue(token);
	const replay = JSON.parse(await page.locator('input[name="replayRequest"]').inputValue());

	await retryButton(page).click();
	await expect(page).toHaveURL(/\/book\/received$/);
	expect((await attemptsFor(page, email)).map((a) => a.key)).toEqual([token, token, token]);
	expect(await submissionsFor(page, email)).toEqual([replay]);
});

test('after persistent 500s, changed answers go only as a new request under a new key', async ({
	page
}) => {
	const email = emailFor('error500');
	await fillAll(page, email);
	const token = await page.locator('input[name="submissionToken"]').inputValue();
	await sendButton(page).click();
	await expect(retryButton(page)).toBeVisible();

	await page.getByRole('button', { name: 'Change my answers' }).click();
	await expect(page.locator('input[name="replayRequest"]')).toHaveCount(0);
	const newToken = await page.locator('input[name="submissionToken"]').inputValue();
	expect(newToken).not.toBe(token);
	await page.getByLabel('How many guests?').fill('90');
	await sendButton(page).click();

	await expect(page).toHaveURL(/\/book\/received$/);
	expect((await attemptsFor(page, email)).map((a) => a.key)).toEqual([token, token, newToken]);
	const [submission] = await submissionsFor(page, email);
	expect(submission?.pricingInputs.guestCount).toBe(90);
});

test('a tampered replay is never sent, and the page offers no retry under that key', async ({
	page
}) => {
	const email = emailFor('down');
	await fillAll(page, email);
	await sendButton(page).click();
	await expect(retryButton(page)).toBeVisible();

	await page
		.locator('input[name="replayRequest"]')
		.evaluate((input: HTMLInputElement) => (input.value = '{"name":"x","total":"1.00"}'));
	await retryButton(page).click();

	await expect(page.getByRole('alert')).toContainText(
		"couldn't safely resend your earlier request"
	);
	await expect(retryButton(page)).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Change my answers' })).toBeVisible();
	await expect(page.getByText(/JSON|SyntaxError/)).toHaveCount(0);
	expect(await attemptsFor(page, email)).toHaveLength(2);
	expect(await submissionsFor(page, email)).toEqual([]);
});

test('changing answers after an unknown outcome sends a new request deliberately', async ({
	page
}) => {
	const email = emailFor('down');
	await fillAll(page, email);
	const token = await page.locator('input[name="submissionToken"]').inputValue();
	await sendButton(page).click();
	await expect(retryButton(page)).toBeVisible();

	await page.getByRole('button', { name: 'Change my answers' }).click();
	await expect(page.locator('[data-frozen]')).toHaveCount(0);
	await expect(page.getByText('Your changes will go as a new request')).toBeVisible();
	const newToken = await page.locator('input[name="submissionToken"]').inputValue();
	expect(newToken).not.toBe(token);

	await page.getByLabel('Tell us about your event').fill('Changed my mind about the date');
	await sendButton(page).click();
	await expect(page).toHaveURL(/\/book\/received$/);
	expect((await attemptsFor(page, email)).map((a) => a.key)).toEqual([token, token, newToken]);
});

test('a catalog change asks for review and sends the reviewed form as a new submission', async ({
	page
}) => {
	const email = emailFor('stale');
	await fillAll(page, email);
	// A fifth topping, which revision 16 no longer lists at all.
	await page.getByRole('checkbox', { name: 'cookie-dough' }).check();
	await page.getByLabel('Tell us about your event').fill('Backyard party');
	const token = await page.locator('input[name="submissionToken"]').inputValue();
	await sendButton(page).click();

	const notice = page.getByRole('alert').filter({ hasText: 'Our menu changed' });
	await expect(notice).toBeVisible();
	await expect(notice).toContainText('Choose your soft serve flavors');
	await expect(page).toHaveURL(/\/book$/);

	// Customer details survive. Horchata is temporarily unavailable now: still listed, unselected
	// and unselectable, and nothing was swapped in for it. Cookie dough was disabled, so it is gone.
	await expect(notice).toContainText('Horchata is unavailable right now — check back later');
	await expect(notice).toContainText("One of the options you chose isn't on our menu anymore");
	await expect(page.getByLabel('Your name')).toHaveValue('Jane Doe');
	await expect(page.getByLabel('ZIP code')).toHaveValue('02134');
	await expect(page.getByLabel('Tell us about your event')).toHaveValue('Backyard party');
	const horchata = page.getByRole('checkbox', { name: /Horchata/ });
	await expect(horchata).toBeVisible();
	await expect(horchata).not.toBeChecked();
	await expect(horchata).toBeDisabled();
	await expect(page.getByRole('checkbox', { name: 'cookie-dough' })).toHaveCount(0);
	await expect(page.getByRole('checkbox', { name: 'Vanilla', exact: true })).toBeChecked();
	await expect(page.getByRole('checkbox', { name: 'Chocolate', exact: true })).not.toBeChecked();
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
	expect(submission?.pricingInputs?.selections).toEqual([
		{ category: 'soft-serve-flavor', offerings: ['vanilla'] },

		{
			category: 'hand-scooped-flavor',
			offerings: [
				'hand-scooped-chocolate-chip',
				'hand-scooped-chocolate',
				'hand-scooped-vanilla-bean',
				'hand-scooped-strawberry'
			]
		},
		{ category: 'topping', offerings: ['sprinkles', 'oreos', 'strawberries', 'brownies'] },
		{ category: 'cone-option', offerings: ['waffle-cone'] }
	]);
});

test('a reused key is not retried behind the customer’s back', async ({ page }) => {
	const email = emailFor('reused');
	await fillAll(page, email);
	const token = await page.locator('input[name="submissionToken"]').inputValue();
	await sendButton(page).click();

	const alert = page.getByRole('alert');
	await expect(alert).toContainText("We couldn't safely verify this submission");
	await expect(page.getByText('diagnostic')).toHaveCount(0);
	expect((await attemptsFor(page, email)).map((a) => a.key)).toEqual([token]);

	await alert.getByRole('button', { name: 'Send as a new request' }).click();
	await expect(page).toHaveURL(/\/book\/received$/);
	const keys = (await attemptsFor(page, email)).map((a) => a.key);
	expect(keys).toHaveLength(2);
	expect(keys[0]).toBe(token);
	expect(keys[1]).not.toBe(token);
});

test('an expired service token is replaced and the same submission resent under its key', async ({
	page
}) => {
	const email = emailFor('expired');
	await fillAll(page, email);
	const token = await page.locator('input[name="submissionToken"]').inputValue();
	await sendButton(page).click();

	// The visitor never notices: the server got a new token and repeated the identical request.
	await expect(page).toHaveURL(/\/book\/received$/);
	const attempts = await attemptsFor(page, email);
	expect(attempts.map((a) => [a.key, a.authorized])).toEqual([
		[token, false],
		[token, true]
	]);
	expect(attempts[1]?.token).not.toBe(attempts[0]?.token);
	expect(await submissionsFor(page, email)).toHaveLength(1);
});

test('a service without permission is an outage to the visitor, not a form problem', async ({
	page
}) => {
	const email = emailFor('forbidden');
	await fillAll(page, email);
	const token = await page.locator('input[name="submissionToken"]').inputValue();
	await sendButton(page).click();

	const alert = page.getByRole('alert');
	await expect(alert).toContainText("We couldn't reach our request system");
	await expect(alert).toContainText("hasn't been sent");
	await expect(page.getByText(/forbidden|permission|fionas\.inquiries/i)).toHaveCount(0);
	// No field is blamed, the answers stay editable, and the same key is kept for the next try.
	await expect(page.locator('[data-frozen]')).toHaveCount(0);
	await expect(page.locator('input[name="submissionToken"]')).toHaveValue(token);
	// A 403 is never answered with a new token and a retry.
	expect(await attemptsFor(page, email)).toHaveLength(1);
	expect(await submissionsFor(page, email)).toEqual([]);
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
		['offering:hand-scooped-flavor', 'hand-scooped-chocolate-chip'],
		['offering:hand-scooped-flavor', 'hand-scooped-chocolate'],
		['offering:hand-scooped-flavor', 'hand-scooped-vanilla-bean'],
		['offering:hand-scooped-flavor', 'hand-scooped-strawberry'],
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

test('nothing the browser receives carries the service credential, a token or the API address', async ({
	page
}) => {
	const responses = [await page.request.get('/book'), await page.request.get('/book/__data.json')];
	for (const response of responses) {
		expect(response.ok()).toBe(true);
		const text = `${JSON.stringify(response.headers())}\n${await response.text()}`;
		for (const secret of SECRETS) expect(text).not.toContain(secret);
		expect(text).not.toContain(stub);
		expect(text).not.toMatch(/COMMERCE_SERVICE_ID|COMMERCE_SERVICE_CREDENTIAL|COMMERCE_API_URL/);
	}
	expect(await responses[0]!.text()).toContain('submissionToken');

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
		expect(text, file).not.toMatch(
			/COMMERCE_SERVICE_ID|COMMERCE_SERVICE_CREDENTIAL|COMMERCE_API_URL|\/auth\/service\/token/
		);
		for (const secret of SECRETS) expect(text, file).not.toContain(secret);
	}
});
