import { expect, test } from '@playwright/test';
import {
	signIn,
	openMaya,
	openBuilder,
	waitForPreview,
	issueButton,
	session,
	route,
	previewThenIssue
} from './request-helpers.js';
test.beforeEach(async ({ page }) => {
	await signIn(page);
	await openMaya(page);
});
test('override, reorder, remove, bespoke service and separate credit retain reviewed identities', async ({
	page,
	context
}, testInfo) => {
	await openBuilder(page);
	const rows = page.getByTestId('quote-line-editor');
	const original = (await session(context)).requests;
	await rows.nth(0).getByLabel('Unit price', { exact: true }).fill('101.00');
	await rows.nth(0).getByLabel('Reason or service note').fill('Negotiated base');
	await waitForPreview(page);
	await rows.nth(1).getByRole('button', { name: 'Move up' }).click();
	await waitForPreview(page);
	await rows.nth(2).getByRole('button', { name: 'Remove', exact: true }).click();
	await waitForPreview(page);
	await page.getByRole('button', { name: '+ New service', exact: true }).click();
	const bespoke = rows.nth(2);
	await bespoke.getByLabel('Description', { exact: true }).fill('Bespoke churros');
	await bespoke.getByLabel('Unit price', { exact: true }).fill('111.00');
	await bespoke.getByLabel('Reason or service note').fill('Customer request');
	await waitForPreview(page);
	await page.getByRole('button', { name: '+ Credit', exact: true }).click();
	await rows.nth(3).getByLabel('Unit price', { exact: true }).fill('-11.00');
	await page.getByLabel('Approved service description').fill('Churro catering for this party');
	await waitForPreview(page);
	await page
		.getByTestId('quote-builder')
		.screenshot({ path: testInfo.outputPath('quote-builder.png') });
	await issueButton(page).click();
	await expect(page).toHaveURL(route);
	await expect(page.getByTestId('service-plan')).toContainText('Churro catering');
	await expect(page.getByTestId('financial-document')).toContainText('Bespoke churros');
	const state = await session(context);
	expect(state.proposalAttempts).toHaveLength(1);
	const command = state.proposalAttempts[0].body;
	expect(command.lines.map((l: { description: string }) => l.description)).toEqual([
		'Ice cream service',
		'Base service',
		'Bespoke churros',
		'Credit'
	]);
	expect(command.lines[0].lineItemId).toBe(
		original[Object.keys(original).find((k) => original[k].inquiry.name === 'Maya Torres')!]
			.financial.lines[1].id
	);
	expect(command.servicePlan.lineNotes).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ note: 'Customer request', key: command.lines[2].key })
		])
	);
	expect(command).not.toHaveProperty('composition');
});
test.describe('native editor', () => {
	test.use({ javaScriptEnabled: false });
	test('native forms edit complete lines and publish only after preview', async ({ page }) => {
		await openBuilder(page, true);
		const blank = page.getByTestId('quote-line-editor').last();
		await blank.getByLabel('New service or adjustment').fill('Bespoke catering');
		await blank.getByLabel('Unit price', { exact: true }).fill('101.00');
		await previewThenIssue(page, true);
		await expect(page.getByTestId('financial-document')).toContainText('Bespoke catering');
	});
});
test('edited inputs with an old fingerprint require a fresh preview and explicit click', async ({
	page,
	context
}) => {
	await openBuilder(page);
	await page
		.locator('[name=unitPrice]')
		.first()
		.evaluate((el: HTMLInputElement) => (el.value = '101.00'));
	await issueButton(page).click();
	expect((await session(context)).proposalAttempts).toHaveLength(0);
	await waitForPreview(page);
	await issueButton(page).click();
	await expect(page).toHaveURL(route);
});
test('issues complete reviewed lines without an optional service plan', async ({
	page,
	context
}) => {
	await openBuilder(page);
	await page.getByLabel('Approved service description').fill('');
	await waitForPreview(page);
	await issueButton(page).click();
	await expect(page).toHaveURL(route);
	await expect(page.getByTestId('request-summary')).toContainText('Quote issued');
	expect((await session(context)).proposalAttempts[0].body).not.toHaveProperty('servicePlan');
	await expect(page.getByTestId('service-plan')).toHaveCount(0);
});
