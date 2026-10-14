import { randomUUID } from 'node:crypto';
import { test, expect } from './test.js';
import { fillContact, fillService, sendButton, deliveriesFor } from './form.js';

test('a failed script load explains the problem and can be retried', async ({ page }) => {
	await page.route(
		'https://challenges.cloudflare.com/turnstile/v0/api.js*',
		(route) => route.abort(),
		{ times: 1 }
	);
	await page.goto('/book');
	await expect(page.getByRole('alert')).toContainText("security check couldn't load");
	await page.getByRole('button', { name: 'try again', exact: true }).click();
	await expect(page.locator('[data-turnstile-complete]')).toHaveAttribute(
		'data-turnstile-complete',
		'true'
	);
});

test('widget sits below send, expired verification blocks sending, and errors can recover', async ({
	page
}) => {
	await page.goto('/book');
	await fillContact(page, `expired-${randomUUID()}@example.com`);
	await fillService(page);
	const widget = page.locator('[data-turnstile-complete]');
	await expect(widget).toHaveAttribute('data-turnstile-complete', 'true');
	const buttonBox = await sendButton(page).boundingBox();
	const widgetBox = await widget.boundingBox();
	expect(widgetBox!.y).toBeGreaterThan(buttonBox!.y);
	expect(widgetBox!.width).toBe(buttonBox!.width);
	await widget.dispatchEvent('test-expire');
	await sendButton(page).click();
	await expect(page.getByRole('alert')).toContainText('complete the security check');
	await widget.dispatchEvent('test-error');
	await page.getByRole('button', { name: 'try again', exact: true }).click();
	await expect(widget).toHaveAttribute('data-turnstile-complete', 'true');
	await sendButton(page).click();
	await expect(page).toHaveURL(/\/book\/received$/);
});

test('server rejects a filled honeypot and a rejected token, then accepts a fresh check', async ({
	page
}) => {
	const email = `security-${randomUUID()}@example.com`;
	await page.goto('/book');
	await fillContact(page, email);
	await fillService(page);
	await expect(page.locator('[data-turnstile-complete]')).toHaveAttribute(
		'data-turnstile-complete',
		'true'
	);
	await page.locator('[name=website]').evaluate((el: HTMLInputElement) => {
		el.value = 'spam';
	});
	await sendButton(page).click();
	await expect(page.getByRole('alert')).toContainText('out of date');
	expect(await deliveriesFor(email)).toHaveLength(0);
	await expect(page.locator('[data-turnstile-complete]')).toHaveAttribute(
		'data-turnstile-complete',
		'true'
	);
	await page.locator('[name=cf-turnstile-response]').evaluate((el: HTMLInputElement) => {
		el.value = 'rejected';
	});
	await sendButton(page).click();
	await expect(page.getByRole('alert')).toContainText('complete the security check');
	expect(await deliveriesFor(email)).toHaveLength(0);
	await expect(page.locator('[data-turnstile-complete]')).toHaveAttribute(
		'data-turnstile-complete',
		'true'
	);
	await sendButton(page).click();
	await expect(page).toHaveURL(/\/book\/received$/);
	expect(await deliveriesFor(email)).toHaveLength(1);
});

test.describe('JavaScript unavailable', () => {
	test.use({ javaScriptEnabled: false });
	test('explains verification and refuses a native submission without a token', async ({
		page
	}) => {
		const email = `no-js-${randomUUID()}@example.com`;
		await page.goto('/book');
		await expect(page.getByText('Please enable JavaScript')).toBeVisible();
		await fillContact(page, email);
		await fillService(page);
		await sendButton(page).click();
		await expect(page.getByRole('alert')).toContainText('complete the security check');
		expect(await deliveriesFor(email)).toHaveLength(0);
		await expect(page.getByLabel('Your name')).toHaveValue('Jane Doe');
	});
});
