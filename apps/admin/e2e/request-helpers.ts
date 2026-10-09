import { expect, type BrowserContext, type Page } from '@playwright/test';
import { mayaId } from './request-fixture.mjs';

export const stubUrl = `http://127.0.0.1:${process.env.ADMIN_STUB_PORT ?? '4176'}`;
export const route = `/requests/${mayaId}`;

/** Read (no update) or replace this browser session's stub state. */
export async function session(context: BrowserContext, update?: unknown) {
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

export async function signIn(page: Page, username = 'brayan') {
	await page.goto('/login');
	await page.getByLabel('User').fill(username);
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/$/);
}

export async function openMaya(page: Page) {
	await page.getByTestId('request-card').filter({ hasText: 'Maya Torres' }).click();
	await expect(page).toHaveURL(route);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Maya Torres');
}

export const issueButton = (page: Page) =>
	page.getByRole('button', { name: 'Issue quote', exact: true });

/** Open the Formal quote panel; with JavaScript, wait for its first preview. */
export async function openBuilder(page: Page, native = false) {
	await page.getByTestId('build-quote').click();
	await expect(page).toHaveURL(`${route}?quote`);
	await expect(page.getByTestId('quote-builder')).toBeVisible();
	if (!native) await waitForPreview(page);
}

/** The preview is current: its deposit is shown and nothing is waiting to be previewed. */
export async function waitForPreview(page: Page) {
	await expect(page.getByTestId('quote-deposit')).toBeVisible();
	await expect(issueButton(page)).toBeEnabled();
}

/** Native forms preview explicitly; enhanced ones have already previewed the current edits. */
export async function previewThenIssue(page: Page, native = false) {
	if (native) await page.getByRole('button', { name: 'Update preview', exact: true }).click();
	else await waitForPreview(page);
	await expect(issueButton(page)).toBeEnabled();
	await issueButton(page).click();
}
