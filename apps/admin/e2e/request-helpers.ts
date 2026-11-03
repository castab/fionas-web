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

/**
 * A hand-made form-action POST sent from inside the signed-in page. Playwright's API request
 * context would carry neither a same-origin Origin (SvelteKit's CSRF guard answers 403 first) nor
 * the Secure session cookie over http, so its refusals never reach the action. This one does, and
 * asserts the result is the action's own failure without backend diagnostics.
 */
export async function postAction(page: Page, path: string, form: Record<string, string>) {
	const result = await page.evaluate(
		async ({ path, form }) => {
			const response = await fetch(path, {
				method: 'POST',
				headers: { accept: 'application/json', 'x-sveltekit-action': 'true' },
				body: new URLSearchParams(form)
			});
			return response.json();
		},
		{ path, form }
	);
	expect(result.type).toBe('failure');
	expect(result.data).not.toContain('PRIVATE');
	return result as { status: number; data: string };
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

export async function openBuilder(page: Page) {
	await page.getByTestId('build-quote').click();
	await expect(page).toHaveURL(`${route}?quote`);
	await expect(page.getByTestId('quote-builder')).toBeVisible();
	await expect(issueButton(page)).toBeDisabled();
}

export async function reviewQuote(page: Page) {
	await page.getByRole('button', { name: 'Review quote', exact: true }).click();
	await expect(page.getByTestId('quote-deposit')).toBeVisible();
	await expect(issueButton(page)).toBeEnabled();
}

export async function previewThenIssue(page: Page) {
	await reviewQuote(page);
	await issueButton(page).click();
}
