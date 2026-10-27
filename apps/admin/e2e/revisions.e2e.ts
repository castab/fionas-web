import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mayaId } from './request-fixture.mjs';
import { revisionFixture, type RevisionState } from './revision-fixture.mjs';
import { session, signIn } from './request-helpers.js';

const route = `/requests/${mayaId}`;
const from = encodeURIComponent('filter=quoted');
const headline = (page: Page) => page.getByTestId('request-summary').getByRole('heading');
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const REVISE = 'Publish revised quote';
const AMEND = 'Approve invoice amendment';

async function open(page: Page, context: BrowserContext, state: RevisionState, search = '') {
	await session(context, { request: revisionFixture(state) });
	await page.goto(route + search);
}
async function noOverflow(page: Page) {
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		)
	).toBeLessThanOrEqual(0);
}
/** Native forms preview explicitly; enhanced ones preview the edit on their own. */
async function review(page: Page, native: boolean, publish: string) {
	if (native) await button(page, 'Update preview').click();
	await expect(page.getByTestId('quote-preview')).toBeVisible();
	await expect(button(page, publish)).toBeEnabled();
}
/** A new flat charge, the one financial edit that reads the same with and without JavaScript. */
async function addCharge(page: Page, native: boolean, label: string, amount: string) {
	if (native) {
		const blank = page.getByTestId('quote-line-editor').last();
		await blank.getByLabel('New service or adjustment').fill(label);
		await blank.getByLabel('Unit price', { exact: true }).fill(amount);
		return;
	}
	await page.getByRole('button', { name: 'Add line' }).click();
	await page.getByRole('button', { name: /^Service/ }).click();
	const row = page.getByTestId('quote-line-editor').last();
	await row.getByLabel('What it’s for').fill(label);
	await row.getByRole('button', { name: 'Flat amount' }).click();
	await row.getByRole('textbox', { name: 'Amount', exact: true }).fill(amount);
}
/** Reprice the first existing line (Maya’s flat Base service). */
async function reprice(page: Page, native: boolean, amount: string) {
	const row = page.getByTestId('quote-line-editor').first();
	if (native) await row.getByLabel('Unit price', { exact: true }).fill(amount);
	else {
		await row.getByRole('button', { name: /^Edit line 1,/ }).click();
		await row.getByRole('textbox', { name: 'Amount', exact: true }).fill(amount);
	}
}
const compare = (page: Page, id: string) => page.getByTestId(id);

for (const native of [false, true]) {
	test.describe(native ? 'native revisions' : 'enhanced revisions', () => {
		test.use({ javaScriptEnabled: !native });
		test.beforeEach(async ({ page }) => {
			await signIn(page);
		});

		test('revise a quote: financial change, then the exact deposit pays against the new proposal', async ({
			page,
			context
		}, testInfo) => {
			await open(page, context, 'quoted');
			const before = (await session(context)).requests[mayaId].proposal.id;
			await expect(page.getByTestId('revise-quote')).toHaveText('Revise quote');
			await expect(page.getByTestId('build-quote')).toHaveCount(0);
			await page.getByTestId('revise-quote').click();
			await expect(page).toHaveURL(`${route}?quote-revision`);
			await expect(page.getByTestId('quote-builder')).toHaveAttribute(
				'data-mode',
				'QUOTE_REVISION'
			);
			// Opens on the current state: nothing previewed, so no expected no-op error.
			await expect(page.getByTestId('quote-preview')).toHaveCount(0);
			expect((await session(context)).revisionAttempts).toHaveLength(0);
			// The negotiated terms and the approved plan are what the editor starts from.
			await expect(page.getByLabel('Approved service description')).toHaveValue(
				'Churro catering for an evening reception'
			);
			await expect(page.getByRole('radio', { name: 'Fixed amount' })).toBeChecked();
			await expect(page.getByLabel('Deposit amount (USD)')).toHaveValue('300.00');
			await addCharge(page, native, 'Extra hour', '50.00');
			await review(page, native, REVISE);
			await expect(compare(page, 'compare-current-total')).toContainText('$415');
			await expect(compare(page, 'quote-total')).toContainText('$465');
			await expect(compare(page, 'compare-difference')).toContainText('+$50');
			await expect(compare(page, 'compare-current-deposit')).toContainText('$300');
			await expect(compare(page, 'quote-deposit')).toContainText('Fixed deposit · $300');
			await expect(page.getByTestId('revision-effects')).toContainText('approved again');
			await expect(page.getByTestId('preview-service-plan')).toContainText('unchanged');
			await noOverflow(page);
			await page
				.getByTestId('quote-builder')
				.screenshot({ path: testInfo.outputPath('revise.png') });
			await button(page, REVISE).click();
			await expect(page).toHaveURL(route);
			await expect(headline(page)).toContainText('Quote issued');
			await expect(page.getByTestId('financial-version')).toContainText('Quote v3');
			await expect(page.getByTestId('financial-document')).toContainText('Extra hour');
			const state = (await session(context)).requests[mayaId];
			expect(state.proposal.id).not.toBe(before);
			expect(state.proposalHistory.map((p: { id: string }) => p.id)).toEqual([
				before,
				state.proposal.id
			]);
			expect(
				(await session(context)).revisionAttempts.map((a: { operation: string }) => a.operation)
			).toEqual(['quote-revision-preview', 'proposals/quote-revisions']);
			// Payment uses the newest proposal; a stale id could never be recorded.
			await page.getByTestId('open-payment').click();
			await page.getByRole('button', { name: 'Record $300 deposit' }).click();
			await expect(headline(page)).toContainText('On the calendar');
			const attempt = (await session(context)).paymentAttempts[0].body;
			expect(attempt.expectedProposalId).toBe(state.proposal.id);
			expect(attempt.expectedProposalId).not.toBe(before);
			// Booking is the one transition revising a quote can never make.
			await expect(page.getByTestId('revise-quote')).toHaveCount(0);
			await expect(page.getByTestId('amend-invoice')).toBeVisible();
		});

		test('a deposit-only change keeps the financial version and approves the new terms', async ({
			page,
			context
		}) => {
			await open(page, context, 'quoted', '?quote-revision');
			await page.getByRole('radio', { name: 'Custom percentage' }).check();
			await page.getByLabel('Deposit percentage').fill('35');
			await review(page, native, REVISE);
			await expect(page.getByTestId('no-financial-change')).toBeVisible();
			await expect(compare(page, 'compare-difference')).toContainText('No change');
			await expect(compare(page, 'quote-deposit')).toContainText('$145.25');
			await expect(compare(page, 'quote-deposit')).toContainText('35% of quote');
			await expect(page.getByTestId('revision-effects')).toContainText('approved again');
			await button(page, REVISE).click();
			await expect(page).toHaveURL(route);
			// No new financial version was invented; the deposit to hold the date changed.
			await expect(page.getByTestId('financial-version')).toContainText('Quote v2');
			await expect(page.getByTestId('deposit-summary')).toContainText('$145.25');
			const state = (await session(context)).requests[mayaId];
			expect(state.financial.version).toBe(2);
			expect(state.depositRequirement.revision).toBe(2);
			expect(state.proposalHistory).toHaveLength(2);
		});

		test('a service-only change publishes a new offer without a new financial version', async ({
			page,
			context
		}) => {
			await open(page, context, 'quoted', '?quote-revision');
			await page.getByLabel('Approved service description').fill('Chocolate service, larger party');
			await page.getByLabel('Guests', { exact: true }).fill('60');
			await review(page, native, REVISE);
			await expect(page.getByTestId('no-financial-change')).toBeVisible();
			await expect(page.getByTestId('preview-service-plan')).toContainText('will change');
			await expect(page.getByTestId('preview-service-plan')).toContainText('Chocolate service');
			// No dummy $0 line or price adjustment was made to allow it.
			await button(page, REVISE).click();
			await expect(page).toHaveURL(route);
			await expect(page.getByTestId('financial-version')).toContainText('Quote v2');
			await expect(page.getByTestId('service-plan')).toContainText(
				'Chocolate service, larger party'
			);
			await expect(page.getByTestId('service-plan')).toContainText('60 guests');
			const state = (await session(context)).requests[mayaId];
			expect(state.financial.lines).toHaveLength(3);
			expect(state.servicePlanHistory.map((p: { revision: number }) => p.revision)).toEqual([1, 2]);
			const sent = (await session(context)).revisionAttempts.at(-1).body;
			expect(sent.servicePlanAction).toBe('REPLACE');
			expect(sent.servicePlan.description).toBe('Chocolate service, larger party');
		});

		test('an untouched or reverted draft is a friendly no-op, never a publication', async ({
			page,
			context
		}) => {
			await open(page, context, 'quoted', '?quote-revision');
			if (native) await button(page, 'Update preview').click();
			else
				await page
					.getByLabel('Approved service description')
					.fill('Churro catering for an evening reception ');
			await expect(page.getByTestId('no-material-change')).toContainText('Nothing has changed');
			expect((await session(context)).requests[mayaId].proposalHistory).toHaveLength(1);
			expect(
				(await session(context)).revisionAttempts.map((a: { operation: string }) => a.operation)
			).not.toContain('proposals/quote-revisions');
		});

		test('Remove the service plan is deliberate, and a blank description alone is refused', async ({
			page,
			context
		}) => {
			await open(page, context, 'quoted', '?quote-revision');
			await page.getByLabel('Approved service description').fill('');
			if (native) await button(page, 'Update preview').click();
			await expect(page.getByRole('alert').first()).toContainText('Remove the service plan');
			expect((await session(context)).revisionAttempts).toHaveLength(0);
			await page.getByLabel('Remove the service plan').check();
			await review(page, native, REVISE);
			await expect(page.getByTestId('preview-plan-cleared')).toBeVisible();
			await expect(page.getByTestId('preview-removed-notes')).toContainText('Negotiated');
			await button(page, REVISE).click();
			await expect(page).toHaveURL(route);
			await expect(page.getByTestId('service-plan')).toHaveCount(0);
			await expect(page.getByTestId('service-plan-cleared')).toContainText('Service plan removed');
			expect((await session(context)).revisionAttempts.at(-1).body.servicePlanAction).toBe('CLEAR');
		});

		test('amend an invoice upward: deposit and payments stay, the balance moves, nothing else changes', async ({
			page,
			context
		}, testInfo) => {
			await open(page, context, 'booked');
			const before = (await session(context)).requests[mayaId];
			await expect(page.getByTestId('amend-invoice')).toHaveText('Amend invoice');
			await expect(page.getByTestId('revise-quote')).toHaveCount(0);
			await page.getByTestId('amend-invoice').click();
			await expect(page).toHaveURL(`${route}?invoice-revision`);
			await expect(page.getByTestId('quote-builder')).toHaveAttribute(
				'data-mode',
				'INVOICE_AMENDMENT'
			);
			// The accepted deposit is context, never a field.
			await expect(page.getByTestId('accepted-deposit')).toContainText('$300');
			await expect(page.getByRole('radio', { name: 'Fixed amount' })).toHaveCount(0);
			await expect(page.getByLabel('Deposit percentage')).toHaveCount(0);
			await addCharge(page, native, 'Late-night extension', '250.00');
			await review(page, native, AMEND);
			await expect(compare(page, 'compare-current-total')).toContainText('$415');
			await expect(compare(page, 'quote-total')).toContainText('$665');
			await expect(compare(page, 'compare-difference')).toContainText('+$250');
			await expect(compare(page, 'compare-paid')).toContainText('$300');
			await expect(compare(page, 'compare-balance')).toContainText('$365');
			await expect(page.getByTestId('invoice-settlement')).toContainText('Balance due');
			await expect(page.getByTestId('invoice-settlement')).toContainText('deposit stays');
			await noOverflow(page);
			await page
				.getByTestId('quote-builder')
				.screenshot({ path: testInfo.outputPath('amend.png') });
			await button(page, AMEND).click();
			await expect(page).toHaveURL(route);
			await expect(headline(page)).toContainText('On the calendar');
			await expect(page.getByTestId('financial-version')).toContainText('Invoice v4');
			await expect(page.getByTestId('request-balance')).toContainText('$365');
			const state = (await session(context)).requests[mayaId];
			expect(state.payments).toEqual(before.payments);
			expect(state.inquiry.lifecycle.stage).toBe('BOOKED');
			expect(state.depositRequirement.requiredAmount.amount).toBe('300.00');
			expect(state.proposalHistory).toHaveLength(1);
			const attempts = (await session(context)).revisionAttempts;
			expect(attempts.map((a: { operation: string }) => a.operation)).toEqual([
				'invoice-revision-preview',
				'invoice-revisions'
			]);
			expect(JSON.stringify(attempts)).not.toMatch(/terms|approvedBy|issuedBy/);
			// A further payment settles against the revised balance; closure is a separate step.
			await page.getByTestId('open-payment').click();
			await page.getByLabel('Payment amount (USD)').fill('365.00');
			await page.getByRole('button', { name: /^Record (\$\S+ )?payment$/ }).click();
			await expect(page.getByTestId('request-balance')).toContainText('$0');
			await expect(page.getByTestId('request-summary')).toContainText('On the calendar');
			await page.getByRole('button', { name: /Mark event served/ }).click();
			await expect(headline(page)).toContainText('Served and paid in full');
			await page.getByRole('button', { name: /Close event/ }).click();
			await expect(page.getByRole('heading', { level: 2 }).first()).toContainText('Event closed');
			// Closed is read-only for ordinary revisions.
			await expect(page.getByTestId('amend-invoice')).toHaveCount(0);
			await page.goto(`${route}?invoice-revision`);
			await expect(page.getByTestId('quote-builder')).toHaveCount(0);
		});

		test('a decrease can overpay: shown plainly, never refunded or closed on the owner’s behalf', async ({
			page,
			context
		}) => {
			await open(page, context, 'booked', '?invoice-revision');
			await reprice(page, native, '1.00');
			// Also zero the remaining lines so the invoice drops below what was paid.
			const rows = page.getByTestId('quote-line-editor');
			if (native) {
				await rows.nth(1).getByLabel('Unit price', { exact: true }).fill('0.00');
				await rows.nth(2).getByLabel('Unit price', { exact: true }).fill('0.00');
			} else {
				for (const n of [1, 2]) {
					await rows
						.nth(n)
						.getByRole('button', { name: new RegExp(`^Edit line ${n + 1},`) })
						.click();
					await rows.nth(n).getByRole('textbox', { name: 'Price each' }).fill('0.00');
				}
			}
			await review(page, native, AMEND);
			await expect(page.getByTestId('invoice-settlement')).toContainText('Overpaid');
			await expect(page.getByTestId('invoice-settlement')).toContainText('separate, explicit step');
			await expect(compare(page, 'compare-balance')).toContainText('-$');
			await button(page, AMEND).click();
			await expect(page).toHaveURL(route);
			await expect(page.getByTestId('request-balance')).toContainText('-$299');
			await expect(page.getByRole('button', { name: /Close event/ })).toHaveCount(0);
			await expect(page.getByTestId('payment-receipt')).toHaveCount(1);
		});

		test('a service-only invoice amendment keeps the version, the accepted plan and the history', async ({
			page,
			context
		}) => {
			await open(page, context, 'booked', '?invoice-revision');
			await page.getByLabel('Approved service description').fill('Chocolate topping, not vanilla');
			await review(page, native, AMEND);
			await expect(page.getByTestId('no-financial-change')).toContainText(
				'service plan is amended'
			);
			await expect(compare(page, 'compare-difference')).toContainText('No change');
			await button(page, AMEND).click();
			await expect(page).toHaveURL(route);
			await expect(page.getByTestId('financial-version')).toContainText('Invoice v3');
			const plan = page.getByTestId('service-plan');
			await expect(plan).toContainText('Chocolate topping, not vanilla');
			await expect(page.getByTestId('service-plan-provenance')).toContainText(
				'Approved with Invoice v3'
			);
			await expect(page.getByTestId('service-plan-provenance')).toContainText('plan revision 2');
			// The plan that booked the event is still there to inspect, and cannot be edited from it.
			await page.getByTestId('accepted-plan').locator('summary').click();
			await expect(page.getByTestId('accepted-plan')).toContainText(
				'Churro catering for an evening'
			);
			const history = page.getByTestId('revision-history');
			await expect(history.getByTestId('history-approvals').getByRole('listitem')).toHaveCount(2);
			await expect(history.getByTestId('history-publications').getByRole('listitem')).toHaveCount(
				1
			);
			await expect(history).toContainText('Accepted with the deposit');
			await expect(history).not.toContainText('Republish');
		});

		test('removing a noted line replaces the plan without its note, visibly', async ({
			page,
			context
		}) => {
			await open(page, context, 'booked', '?invoice-revision');
			const rows = page.getByTestId('quote-line-editor');
			if (native) {
				// Native forms remove a line with its own button, then preview.
				await rows
					.first()
					.getByRole('button', { name: /Remove/ })
					.click();
				await expect(page.getByTestId('dropped-notes')).toContainText('Negotiated');
				await button(page, 'Update preview').click();
			} else {
				await rows
					.first()
					.getByRole('button', { name: /^Edit line 1,/ })
					.click();
				await rows.first().getByRole('button', { name: 'Remove line' }).click();
				await expect(page.getByTestId('dropped-notes')).toContainText('Negotiated');
			}
			await expect(page.getByTestId('preview-removed-notes')).toContainText('Negotiated');
			await expect(button(page, AMEND)).toBeEnabled();
			await button(page, AMEND).click();
			await expect(page).toHaveURL(route);
			const sent = (await session(context)).revisionAttempts.at(-1).body;
			expect(sent.servicePlanAction).toBe('REPLACE');
			expect(JSON.stringify(sent.servicePlan)).not.toContain('Negotiated');
		});

		test('a stale review is re-previewed for a human, never silently resubmitted', async ({
			page,
			context
		}) => {
			await open(page, context, 'booked', '?invoice-revision');
			await addCharge(page, native, 'Extra hour', '40.00');
			await review(page, native, AMEND);
			await session(context, { mode: 'quote-review-stale' });
			await button(page, AMEND).click();
			await expect(page.getByText('The booking changed since you reviewed it')).toBeVisible();
			expect(
				(await session(context)).revisionAttempts.filter(
					(a: { operation: string }) => a.operation === 'invoice-revisions'
				)
			).toHaveLength(1);
			expect((await session(context)).requests[mayaId].financial.version).toBe(3);
			await review(page, native, AMEND);
			await button(page, AMEND).click();
			await expect(page).toHaveURL(route);
			await expect(page.getByTestId('financial-version')).toContainText('Invoice v4');
		});

		test('an uncertain approval blocks replay until the request is reloaded and inspected', async ({
			page,
			context
		}) => {
			await open(page, context, 'booked', '?invoice-revision');
			await addCharge(page, native, 'Extra hour', '40.00');
			await review(page, native, AMEND);
			await session(context, { mode: 'revision-ambiguous' });
			await button(page, AMEND).click();
			await expect(page.getByRole('alert').first()).toContainText('couldn’t confirm');
			await expect(button(page, AMEND)).toBeDisabled();
			expect(
				(await session(context)).revisionAttempts.filter(
					(a: { operation: string }) => a.operation === 'invoice-revisions'
				)
			).toHaveLength(1);
			await page.getByRole('link', { name: 'Reload to review' }).first().click();
			// The committed amendment is visible on reload; no second attempt was made.
			await expect(page.getByTestId('financial-version')).toContainText('Invoice v4');
		});
	});
}

test.describe('returning to the Requests list', () => {
	test('revise and amend keep the return context through open, cancel and publish', async ({
		page,
		context
	}) => {
		await signIn(page);
		await open(page, context, 'quoted', `?quote-revision&from=${from}`);
		const back = page.getByTestId('workspace-back');
		await expect(back).toHaveText('← Back to requests');
		await expect(back).toHaveAttribute('href', /\/requests\?filter=quoted$/);
		await page.getByRole('link', { name: 'Cancel' }).click();
		await expect(page).toHaveURL(`${route}?from=${from}`);
		await expect(page.getByTestId('quote-builder')).toHaveCount(0);
		await page.getByTestId('revise-quote').click();
		await expect(page).toHaveURL(`${route}?quote-revision&from=${from}`);
		await page.getByLabel('Approved service description').fill('Different plan');
		await expect(button(page, REVISE)).toBeEnabled();
		await button(page, REVISE).click();
		await expect(page).toHaveURL(`${route}?from=${from}`);
		await expect(page.getByTestId('workspace-back')).toHaveAttribute('href', /filter=quoted$/);
		// Browser Back returns to the editor URL, reloadable to the same editor.
		await page.goBack();
		await expect(page).toHaveURL(`${route}?quote-revision&from=${from}`);
		await page.reload();
		await expect(page.getByTestId('quote-builder')).toHaveAttribute('data-mode', 'QUOTE_REVISION');
		await page.getByTestId('workspace-back').click();
		await expect(page).toHaveURL(/\/requests\?filter=quoted$/);
	});
	test('a flag the lifecycle does not offer opens nothing and exposes no action', async ({
		page,
		context
	}) => {
		await signIn(page);
		await open(page, context, 'quoted', '?quote&invoice-revision');
		await expect(page.getByTestId('quote-builder')).toHaveCount(0);
		await expect(page.getByTestId('build-quote')).toHaveCount(0);
		await expect(page.getByTestId('amend-invoice')).toHaveCount(0);
		await open(page, context, 'closed', '?quote-revision&invoice-revision');
		await expect(page.getByTestId('quote-builder')).toHaveCount(0);
		await open(page, context, 'declined', '?quote-revision&quote');
		await expect(page.getByTestId('quote-builder')).toHaveCount(0);
	});
	test('a hostile return destination still falls back safely beside an editor flag', async ({
		page,
		context
	}) => {
		await signIn(page);
		await open(
			page,
			context,
			'booked',
			`?invoice-revision&from=${encodeURIComponent('//evil.test')}`
		);
		await expect(page.getByTestId('workspace-back')).toHaveText('← Back to dashboard');
		await expect(page.getByTestId('quote-builder')).toBeVisible();
	});
});

test.describe('permissions', () => {
	test('quote authority revises quotes; invoice authority alone amends invoices', async ({
		page,
		context
	}) => {
		await signIn(page);
		const invoiceOnly = [
			'fionas.inquiries.read',
			'commerce.financial-document.read',
			'commerce.financial-document.create',
			'fionas.financial-terms.manage',
			'commerce.payment.record'
		];
		await session(context, { permissions: invoiceOnly, request: revisionFixture('quoted') });
		await page.goto(route);
		// No deposit authority: a quote cannot be revised, but the booking and plan remain readable.
		await expect(page.getByTestId('revise-quote')).toHaveCount(0);
		await expect(page.getByTestId('service-plan')).toBeVisible();
		await page.goto(`${route}?quote-revision`);
		await expect(page.getByTestId('quote-builder')).toHaveCount(0);
		await session(context, { request: revisionFixture('booked') });
		await page.goto(route);
		await expect(page.getByTestId('amend-invoice')).toBeVisible();
		await session(context, {
			permissions: ['fionas.inquiries.read', 'commerce.financial-document.read']
		});
		await page.goto(route);
		await expect(page.getByTestId('amend-invoice')).toHaveCount(0);
		await expect(page.getByTestId('financial-document')).toBeVisible();
		await expect(page.getByTestId('revision-history')).toBeVisible();
	});
	test('a read-only account sees current and historical information without mutation controls', async ({
		page,
		context
	}) => {
		await signIn(page, 'request-read-only');
		await session(context, { request: revisionFixture('invoice-service-amendment') });
		await page.goto(route);
		await expect(page.getByTestId('amend-invoice')).toHaveCount(0);
		await expect(page.getByTestId('revision-history')).toContainText('Service plan updated');
		await page.goto(`${route}?invoice-revision`);
		await expect(page.getByTestId('quote-builder')).toHaveCount(0);
	});
});

test.describe('what the workspace shows', () => {
	test.beforeEach(async ({ page }) => {
		await signIn(page);
	});
	test('a cleared plan reads as intentionally removed, never as never approved', async ({
		page,
		context
	}) => {
		await open(page, context, 'plan-cleared');
		await expect(page.getByTestId('service-plan')).toHaveCount(0);
		await expect(page.getByTestId('service-plan-cleared')).toContainText('Service plan removed');
		await expect(page.getByTestId('accepted-plan')).toContainText('revision 1');
		await expect(page.getByTestId('revision-history')).toContainText('Service plan removed');
		await page.goto(`${route}?invoice-revision`);
		await expect(page.getByTestId('plan-state')).toContainText('was removed');
		await expect(page.getByLabel('Approved service description')).toHaveValue('');
		await expect(page.getByLabel('Remove the service plan')).toHaveCount(0);
		// Staff can explicitly create a new commitment.
		await page.getByLabel('Approved service description').fill('A brand new commitment');
		await expect(button(page, AMEND)).toBeEnabled();
		expect((await session(context)).revisionAttempts.at(-1)?.body.servicePlanAction).toBe(
			'REPLACE'
		);
	});
	test('a retained plan keeps pointing at the snapshot it was approved against', async ({
		page,
		context
	}) => {
		await open(page, context, 'historical-plan');
		await expect(page.getByTestId('financial-version')).toContainText('Quote v3');
		await expect(page.getByTestId('service-plan-provenance')).toContainText(
			'Approved with Quote v2'
		);
		await expect(page.getByTestId('line-provenance')).toContainText('Negotiated');
	});
	test('history lists publications and approvals; financial versions load on request and fail gently', async ({
		page,
		context
	}) => {
		await open(page, context, 'invoice-financial-amendment');
		const history = page.getByTestId('revision-history');
		await expect(history.getByTestId('history-publications')).toContainText('Quote issued');
		await expect(history.getByTestId('history-publications')).toContainText('Accepted');
		await expect(history.getByTestId('history-versions')).toHaveCount(0);
		await history.getByTestId('history-open').click();
		await expect(page).toHaveURL(`${route}?history`);
		const versions = history.getByTestId('history-versions').getByRole('listitem');
		await expect(versions.first()).toContainText('Invoice v4');
		await expect(versions.first()).toContainText('Current');
		await expect(history.getByTestId('history-deposits')).toContainText('Deposit terms revision 1');
		// Inspecting a historical version offers no editing or republish control.
		await expect(history.getByRole('button', { name: /publish|approve|republish/i })).toHaveCount(
			0
		);
		await session(context, { mode: 'history-unavailable' });
		await page.reload();
		await expect(history.getByTestId('history-unavailable')).toContainText('unavailable');
		await expect(page.getByTestId('financial-document')).toBeVisible();
		await expect(page.getByTestId('request-balance')).toBeVisible();
		await expect(history.getByTestId('history-publications')).toBeVisible();
		await session(context, { mode: 'history-malformed' });
		await page.reload();
		await expect(history.getByTestId('history-unavailable')).toBeVisible();
	});
	test('served events can still be amended; closed and declined cannot', async ({
		page,
		context
	}) => {
		await open(page, context, 'served');
		await expect(page.getByTestId('amend-invoice')).toBeVisible();
		await page.getByTestId('amend-invoice').click();
		await addCharge(page, false, 'Cleanup fee', '25.00');
		await review(page, false, AMEND);
		await button(page, AMEND).click();
		// Amending after service leaves the event served: closure stays a separate, explicit step.
		await expect(page).toHaveURL(route);
		await expect(page.getByTestId('request-summary')).toContainText('Served');
		await expect(page.getByTestId('request-summary')).toContainText('balance due');
		await expect(page.getByRole('button', { name: /Close event/ })).toHaveCount(0);
		await expect(page.getByRole('button', { name: /Mark event served/ })).toHaveCount(0);
		await open(page, context, 'closed');
		await expect(page.getByTestId('amend-invoice')).toHaveCount(0);
		await expect(page.getByTestId('revise-quote')).toHaveCount(0);
		await open(page, context, 'declined');
		await expect(page.getByTestId('amend-invoice')).toHaveCount(0);
		await expect(page.getByTestId('revise-quote')).toHaveCount(0);
		await expect(page.getByTestId('revision-history')).toHaveCount(0);
	});
	test('the editor and its preview fit a narrow screen', async ({ page, context }, testInfo) => {
		await open(page, context, 'booked', '?invoice-revision');
		await addCharge(
			page,
			false,
			'A very long additional charge description to wrap',
			'12345678.00'
		);
		await review(page, false, AMEND);
		await noOverflow(page);
		await page
			.getByTestId('quote-builder')
			.screenshot({ path: testInfo.outputPath(`amend-${testInfo.project.name}.png`) });
	});
});
