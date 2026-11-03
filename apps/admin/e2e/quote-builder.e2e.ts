import { expect, test } from '@playwright/test';
import {
	signIn,
	openMaya,
	openBuilder,
	reviewQuote,
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
	// Lines are summaries until opened; one editor is open at a time.
	const editLine = (n: number) =>
		rows
			.nth(n)
			.getByRole('button', { name: new RegExp(`^Edit line ${n + 1},`) })
			.click();
	const addLine = async (kind: string) => {
		await page.getByRole('button', { name: 'Add line' }).click();
		await page.getByRole('button', { name: new RegExp(`^${kind}`) }).click();
	};
	await editLine(0);
	await rows.nth(0).getByRole('textbox', { name: 'Amount', exact: true }).fill('101.00');
	await rows.nth(0).getByText('Tax & note').click();
	await rows.nth(0).getByLabel('Why this line').fill('Negotiated base');
	await editLine(1);
	await rows.nth(1).getByRole('button', { name: 'Move up' }).click();
	await editLine(2);
	await rows.nth(2).getByRole('button', { name: 'Remove line' }).click();
	await addLine('Service');
	const bespoke = rows.nth(2);
	await bespoke.getByLabel('What it’s for').fill('Bespoke churros');
	await bespoke.getByRole('button', { name: 'Flat amount' }).click();
	await bespoke.getByRole('textbox', { name: 'Amount', exact: true }).fill('111.00');
	await bespoke.getByText('Tax & note').click();
	await bespoke.getByLabel('Why this line').fill('Customer request');
	await addLine('Credit');
	await rows.nth(3).getByLabel('Credit name').fill('Credit');
	await rows.nth(3).getByLabel('Credit amount').fill('11.00');
	await page.getByLabel('Approved service description').fill('Churro catering for this party');
	await reviewQuote(page);
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
	expect(command.lines[3].unitPrice).toBe('-11.00');
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
		await openBuilder(page);
		const blank = page.getByTestId('quote-line-editor').last();
		await blank.getByLabel('New service or adjustment').fill('Bespoke catering');
		await blank.getByLabel('Unit price', { exact: true }).fill('101.00');
		await previewThenIssue(page);
		await expect(page.getByTestId('financial-document')).toContainText('Bespoke catering');
	});
});
test('edited inputs with an old fingerprint require a fresh preview and explicit click', async ({
	page,
	context
}) => {
	await openBuilder(page);
	await reviewQuote(page);
	await page
		.locator('[name=unitPrice]')
		.first()
		.evaluate((el: HTMLInputElement) => (el.value = '101.00'));
	await issueButton(page).click();
	await expect(page.getByText('The quote changed since you reviewed it')).toBeVisible();
	expect((await session(context)).proposalAttempts).toHaveLength(0);
	await issueButton(page).click();
	await expect(page).toHaveURL(route);
});
test('issues complete reviewed lines without an optional service plan', async ({
	page,
	context
}) => {
	await openBuilder(page);
	await page.getByLabel('Approved service description').fill('');
	await reviewQuote(page);
	await issueButton(page).click();
	await expect(page).toHaveURL(route);
	await expect(page.getByTestId('request-summary')).toContainText('Quote issued');
	expect((await session(context)).proposalAttempts[0].body).not.toHaveProperty('servicePlan');
	await expect(page.getByTestId('service-plan')).toHaveCount(0);
});

test('slow typing stays local and an obsolete review preserves the current edit and caret', async ({
	page,
	context
}) => {
	await openBuilder(page);
	const previewPosts: string[] = [];
	page.on('request', (request) => {
		if (request.method() === 'POST' && request.url().includes('/previewQuote'))
			previewPosts.push(request.url());
	});
	const line = page.getByTestId('quote-line-editor').first();
	await line.getByRole('button', { name: /^Edit line 1,/ }).click();
	const amount = line.getByRole('textbox', { name: 'Amount', exact: true });
	const description = page.getByLabel('Approved service description');
	for (const [field, initial, insert] of [
		[amount, '1.00', '23'],
		[description, 'AB', 'cd']
	] as const) {
		await field.fill(initial);
		await field.evaluate((el: HTMLInputElement | HTMLTextAreaElement) =>
			el.setSelectionRange(1, 1)
		);
		for (const [i, char] of [...insert].entries()) {
			await field.pressSequentially(char, { delay: 400 });
			await expect(field).toBeEnabled();
			await expect(field).toBeFocused();
			await expect(field).toHaveJSProperty('selectionStart', i + 2);
			await expect(field).toHaveJSProperty('selectionEnd', i + 2);
		}
		await expect(field).toHaveValue(initial.slice(0, 1) + insert + initial.slice(1));
	}
	expect(previewPosts).toHaveLength(0);
	expect((await session(context)).previewAttempts).toHaveLength(0);
	const gate = Promise.withResolvers<void>();
	await page.route(
		'**/*/previewQuote',
		async (intercepted) => {
			const response = await intercepted.fetch();
			await gate.promise;
			await intercepted.fulfill({ response });
		},
		{ times: 1 }
	);
	const review = page.getByRole('button', { name: 'Review quote', exact: true });
	await review.click();
	try {
		const reviewing = page.getByRole('button', { name: 'Reviewing…' });
		await expect(reviewing).toBeDisabled();
		await expect(reviewing).toBeFocused();
		await description.focus();
		await description.press('Home');
		await description.pressSequentially('Fresh ');
	} finally {
		gate.resolve();
	}
	await expect(review).toBeEnabled();
	await expect(description).toHaveValue('Fresh AcdB');
	await expect(description).toBeFocused();
	await expect(description).toHaveJSProperty('selectionStart', 6);
	await expect(description).toHaveJSProperty('selectionEnd', 6);
	await expect(page.getByTestId('quote-preview')).toHaveCount(0);
	await expect(issueButton(page)).toBeDisabled();
	await reviewQuote(page);
	await description.fill('Final service plan');
	await expect(issueButton(page)).toBeDisabled();
	await expect(page.getByTestId('quote-preview')).toHaveCount(0);
	await reviewQuote(page);
	expect(previewPosts).toHaveLength(3);
	const before = await session(context);
	expect(before.previewAttempts).toHaveLength(3);
	expect(before.proposalAttempts).toHaveLength(0);
	await issueButton(page).click();
	await expect(page).toHaveURL(route);
	const after = await session(context);
	expect(after.proposalAttempts).toHaveLength(1);
	expect(after.proposalAttempts[0].body.servicePlan.description).toBe('Final service plan');
});

test('an unavailable review preserves the draft for an explicit retry', async ({
	page,
	context
}) => {
	await openBuilder(page);
	const description = page.getByLabel('Approved service description');
	await description.fill('Service with extra toppings');
	await session(context, { mode: 'preview-unavailable' });
	await page.getByRole('button', { name: 'Review quote', exact: true }).click();
	await expect(page.getByRole('alert').first()).toContainText('Try again');
	await expect(description).toHaveValue('Service with extra toppings');
	await expect(description).toBeEnabled();
	await expect(issueButton(page)).toBeDisabled();
	await session(context, {});
	await reviewQuote(page);
	expect((await session(context)).proposalAttempts).toHaveLength(0);
});

test('correcting a reviewed line clears its error and leaves unrelated deposit feedback intact', async ({
	page
}) => {
	await openBuilder(page);
	const line = page.getByTestId('quote-line-editor').first();
	await line.getByRole('button', { name: /^Edit line 1,/ }).click();
	const amount = line.getByRole('textbox', { name: 'Amount', exact: true });
	await amount.fill('invalid');
	const guests = page.getByLabel('Guests', { exact: true });
	await guests.fill('0');
	await page.getByRole('radio', { name: 'Fixed amount' }).check();
	const deposit = page.getByLabel('Deposit amount (USD)');
	await deposit.fill('0');
	let reviews = 0;
	page.on('request', (request) => {
		if (request.method() === 'POST' && request.url().includes('/previewQuote')) reviews++;
	});
	await page.getByRole('button', { name: 'Review quote', exact: true }).click();
	await expect(line.getByRole('alert')).toContainText('exact amount');
	await expect(deposit).toHaveAttribute('aria-invalid', 'true');
	await amount.fill('125.00');
	await expect(line.getByRole('alert')).toHaveCount(0);
	await expect(page.getByText(/Check the description, exact amount/)).toHaveCount(0);
	await expect(amount).toBeFocused();
	await expect(amount).toHaveJSProperty('selectionStart', 6);
	await expect(
		page
			.getByRole('alert')
			.filter({ hasText: 'Check the approved service description and counts.' })
	).toBeVisible();
	await guests.fill('40');
	await expect(deposit).toHaveAttribute('aria-invalid', 'true');
	await page.getByRole('radio', { name: 'Custom percentage' }).check();
	await expect(deposit).not.toHaveAttribute('aria-invalid', 'true');
	await expect(page.getByRole('alert')).toHaveCount(0);
	const percentage = page.getByLabel('Deposit percentage', { exact: true });
	await percentage.fill('101');
	await page.getByRole('button', { name: 'Review quote', exact: true }).click();
	await expect(percentage).toHaveAttribute('aria-invalid', 'true');
	await percentage.fill('25');
	await expect(percentage).not.toHaveAttribute('aria-invalid', 'true');
	await expect(issueButton(page)).toBeDisabled();
	expect(reviews).toBe(2);
	await previewThenIssue(page);
	await expect(page).toHaveURL(route);
	expect(reviews).toBe(3);
});

test('moving a line discards position-indexed feedback and late validation cannot restore it', async ({
	page
}) => {
	await openBuilder(page);
	const rows = page.getByTestId('quote-line-editor');
	await rows
		.first()
		.getByRole('button', { name: /^Edit line 1,/ })
		.click();
	await rows.first().getByRole('textbox', { name: 'Amount', exact: true }).fill('invalid');
	const review = page.getByRole('button', { name: 'Review quote', exact: true });
	await review.click();
	await expect(rows.first().getByRole('alert')).toContainText('exact amount');
	await rows.first().getByRole('button', { name: 'Move down' }).click();
	await expect(page.getByRole('alert')).toHaveCount(0);
	const gate = Promise.withResolvers<void>();
	await page.route(
		'**/*/previewQuote',
		async (intercepted) => {
			const response = await intercepted.fetch();
			await gate.promise;
			await intercepted.fulfill({ response });
		},
		{ times: 1 }
	);
	await review.click();
	const amount = rows.nth(1).getByRole('textbox', { name: 'Amount', exact: true });
	try {
		await expect(page.getByRole('button', { name: 'Reviewing…' })).toBeDisabled();
		await amount.fill('105.00');
	} finally {
		gate.resolve();
	}
	await expect(review).toBeEnabled();
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(amount).toBeFocused();
	await expect(amount).toHaveValue('105.00');
	await expect(issueButton(page)).toBeDisabled();
	await reviewQuote(page);
});
