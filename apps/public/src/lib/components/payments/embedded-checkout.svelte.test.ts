import { describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { OnPageCheckoutLaunch } from '$lib/payments/controller.js';
import type { EmbeddedFactory } from '$lib/payments/embedded.js';
import { embeddedSecret } from '$lib/payments/testing/fixtures.js';
import EmbeddedCheckout from './embedded-checkout.svelte';

const key = 'pk_test_51FionasTestKey0123456789';

function launch(overrides: Partial<OnPageCheckoutLaunch> = {}): OnPageCheckoutLaunch {
	return {
		id: 1,
		mode: 'EMBEDDED',
		attemptId: '5d0b8f8e-29c4-4d6e-9f63-0b9b4f1d2a77',
		purpose: 'DEPOSIT',
		amountCents: 24000n,
		businessRevision: 4,
		isCurrent: () => true,
		clientSecret: () => Promise.resolve(embeddedSecret),
		...overrides
	};
}

/** A Stripe.js stand-in that renders a placeholder iframe and records its lifecycle. */
function fakeStripe(options: { failFirst?: 'load' | 'mount' } = {}) {
	const log: string[] = [];
	const completions: (() => void)[] = [];
	let created = 0;
	const factory: EmbeddedFactory = async (_key, { fetchClientSecret, onComplete }) => {
		const n = ++created;
		log.push(`create:${n}`);
		if (options.failFirst === 'load' && n === 1) throw new Error('Failed to load Stripe.js');
		await fetchClientSecret();
		completions.push(onComplete);
		let frame: HTMLIFrameElement | null = null;
		return {
			mount(element) {
				if (options.failFirst === 'mount' && n === 1) throw new Error('mount failed');
				frame = document.createElement('iframe');
				frame.title = 'Secure payment input frame';
				element.append(frame);
				log.push(`mount:${n}`);
			},
			destroy() {
				frame?.remove();
				log.push(`destroy:${n}`);
			}
		};
	};
	return { factory, log, completions };
}

describe('embedded Checkout panel', () => {
	it('frames Stripe with the authorized amount, mounts once and cleans up', async () => {
		const stripe = fakeStripe();
		const oncomplete = vi.fn();
		const onclose = vi.fn();
		const screen = render(EmbeddedCheckout, {
			launch: launch(),
			publishableKey: key,
			factory: stripe.factory,
			oncomplete,
			onclose
		});
		await expect
			.element(page.getByRole('heading', { name: 'Complete your payment' }))
			.toHaveFocus();
		await expect.element(page.getByTestId('embedded-amount')).toHaveTextContent('$240.00');
		await expect
			.element(page.getByTestId('embedded-description'))
			.toHaveTextContent("Deposit for your Fiona's Ice Cream booking");
		// Customers never see generated version labels.
		await expect.element(page.getByTestId('embedded-description')).not.toHaveTextContent(/v\d/);
		await expect.element(page.getByTitle('Secure payment input frame')).toBeInTheDocument();
		await expect.element(page.getByTestId('embedded-loading')).not.toBeInTheDocument();
		expect(stripe.log).toEqual(['create:1', 'mount:1']);
		expect(screen.container.innerHTML).not.toContain(embeddedSecret);

		stripe.completions[0]();
		expect(oncomplete).toHaveBeenCalledWith(1);
		await page.getByRole('button', { name: 'Back to booking overview' }).click();
		expect(onclose).toHaveBeenCalledOnce();

		await screen.unmount();
		expect(stripe.log).toEqual(['create:1', 'mount:1', 'destroy:1']);
		expect(document.querySelectorAll('iframe')).toHaveLength(0);
		stripe.completions[0](); // a late Stripe callback after cleanup does nothing
		expect(oncomplete).toHaveBeenCalledOnce();
	});

	it('M: a failed load offers a retry of the same launch, never a new payment', async () => {
		const stripe = fakeStripe({ failFirst: 'load' });
		const clientSecret = vi.fn(() => Promise.resolve(embeddedSecret));
		const screen = render(EmbeddedCheckout, {
			launch: launch({ clientSecret }),
			publishableKey: key,
			factory: stripe.factory,
			oncomplete: () => undefined,
			onclose: () => undefined
		});
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent('Trying again opens the same payment');
		expect(screen.container.innerHTML).not.toContain(embeddedSecret);
		await page.getByRole('button', { name: 'Try again' }).click();
		await expect.element(page.getByTitle('Secure payment input frame')).toBeInTheDocument();
		expect(stripe.log).toEqual(['create:1', 'create:2', 'mount:2']);
		expect(clientSecret).toHaveBeenCalledOnce(); // the same in-memory launch, read only by Stripe
		await screen.unmount();
		expect(stripe.log.at(-1)).toBe('destroy:2');
	});

	it('explains a missing publishable key without loading Stripe or offering a retry', async () => {
		const stripe = fakeStripe();
		render(EmbeddedCheckout, {
			launch: launch({ purpose: 'INVOICE', amountCents: 10000n, businessRevision: 8 }),
			publishableKey: null,
			factory: stripe.factory,
			oncomplete: () => undefined,
			onclose: () => undefined
		});
		await expect.element(page.getByRole('alert')).toHaveTextContent("isn't available on this page");
		await expect
			.element(page.getByTestId('embedded-description'))
			.toHaveTextContent('Payment toward your Invoice');
		await expect.element(page.getByTestId('embedded-description')).not.toHaveTextContent(/v\d/);
		await expect.element(page.getByTestId('embedded-amount')).toHaveTextContent('$100.00');
		await expect.element(page.getByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
		expect(stripe.log).toEqual([]);
	});
});
