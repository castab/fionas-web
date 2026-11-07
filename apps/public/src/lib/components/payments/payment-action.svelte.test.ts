import { expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { readPaymentSummary } from '$lib/payments/contract.js';
import type { PageState } from '$lib/payments/controller.js';
import { bookedSummary, restartEligible, restartToken } from '$lib/payments/testing/fixtures.js';
import { paymentView } from '$lib/payments/view.js';
import PaymentAction from './payment-action.svelte';

function current(overrides: Record<string, unknown> = {}): PageState {
	const summary = readPaymentSummary(bookedSummary({ ...restartEligible, ...overrides }))!;
	return {
		phase: 'ready',
		summary,
		view: paymentView(summary),
		notice: null,
		busy: null,
		pending: null,
		polling: 'idle',
		persistent: true,
		checkout: null,
		summaryFresh: true,
		paymentUncertain: false
	};
}

function mount() {
	const onrestart = vi.fn();
	const props = {
		current: current(),
		onrestart,
		onpay: vi.fn(),
		onrecover: vi.fn(),
		onretry: vi.fn(),
		onstartover: vi.fn(),
		onrefresh: vi.fn()
	};
	return { screen: render(PaymentAction, props), props, onrestart };
}

it('lets the customer correct the amount before explicitly authorizing the reviewed restart', async () => {
	const { onrestart } = mount();
	await page.getByTestId('review-restart').click();
	await page.getByRole('radio', { name: 'A different amount' }).click();
	const amount = page.getByRole('textbox', { name: 'Amount (USD)' });
	await amount.fill('960.01');
	await page.getByTestId('submit-restart').click();
	expect(onrestart).not.toHaveBeenCalled();
	await amount.fill('150.01');
	expect(onrestart).not.toHaveBeenCalled();
	await page.getByRole('button', { name: 'Restart checkout for $150.01' }).click();
	expect(onrestart).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ token: restartToken }),
		{ partialCents: 15001n }
	);
});

it('requires a new review if polling changes the restart target while the chooser is open', async () => {
	const { screen, props, onrestart } = mount();
	await page.getByTestId('review-restart').click();
	await screen.rerender({
		...props,
		current: current({ checkoutRestartToken: restartToken.replace(/B+$/, 'C'.repeat(43)) })
	});
	await expect.element(page.getByTestId('submit-restart')).not.toBeInTheDocument();
	await expect
		.element(page.getByText('Your checkout details changed.', { exact: false }))
		.toBeVisible();
	await expect.element(page.getByTestId('review-restart')).toBeVisible();
	expect(onrestart).not.toHaveBeenCalled();
});
