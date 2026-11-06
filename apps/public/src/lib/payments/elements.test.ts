import type {
	StripeCheckoutConfirmResult,
	StripeCheckoutSession,
	StripeCheckoutValidateElementsResult
} from '@stripe/stripe-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OnPageCheckoutLaunch } from './controller.js';
import { startCheckoutElements, type ElementsLoader } from './elements.js';
import { embeddedSecret } from './testing/fixtures.js';

const baseSession = {
	status: { type: 'open' },
	currency: 'usd',
	minorUnitsAmountDivisor: 100,
	total: { total: { minorUnitsAmount: 48000, amount: 'intentionally ignored' } },
	canConfirm: false
} as StripeCheckoutSession;

function fixture({
	initial = baseSession,
	prepareConfirmation = vi.fn(async () => true),
	initialization = Promise.resolve()
} = {}) {
	const contactMount = {} as HTMLElement;
	const paymentMount = {} as HTMLElement;
	const onChange = vi.fn();
	const onPending = vi.fn();
	const onRetryable = vi.fn();
	const beginConfirmation = vi.fn(() => true);
	const launch: OnPageCheckoutLaunch = {
		mode: 'ELEMENTS',
		id: 1,
		attemptId: '8cf42464-739b-43ca-b684-d0f802245c55',
		purpose: 'INVOICE',
		amountCents: 48000n,
		businessRevision: 4,
		isCurrent: vi.fn(() => true),
		clientSecret: async () => embeddedSecret
	};
	const tokens: Record<string, string> = {
		'--brand': '#5f5b40',
		'--surface-card': '#f6f1e4',
		'--font-sans': 'Poppins, sans-serif',
		'--radius-input': '10px'
	};
	vi.stubGlobal('getComputedStyle', () => ({
		getPropertyValue: (token: string) => tokens[token] ?? '#3d3a2b'
	}));
	function element() {
		const handlers = new Map<string, () => void>();
		return {
			handlers,
			on: (name: string, callback: () => void) => handlers.set(name, callback),
			mount: vi.fn(() => handlers.get('ready')?.()),
			destroy: vi.fn()
		};
	}
	const contact = element();
	const payment = element();
	let session = initial;
	let listener: (session: StripeCheckoutSession) => void;
	const confirm = vi.fn<() => Promise<StripeCheckoutConfirmResult>>();
	const actions = {
		getSession: vi.fn(() => session),
		validateElements: vi.fn(async (): Promise<StripeCheckoutValidateElementsResult> => ({
			type: 'success',
			session
		})),
		confirm
	};
	const sdk = {
		on: vi.fn((_event, callback) => (listener = callback)),
		loadActions: vi.fn(async () => ({ type: 'success', actions })),
		createContactDetailsElement: vi.fn(() => contact),
		createPaymentElement: vi.fn(() => payment)
	};
	const initialize = vi.fn(() => sdk);
	const loadStripe = vi.fn(async () => {
		await initialization;
		return { initCheckoutElementsSdk: initialize };
	});
	const form = startCheckoutElements({
		loadStripe: loadStripe as unknown as ElementsLoader,
		launch,
		publishableKey: 'pk_test_51FionasTestKey0123456789',
		contactMount,
		paymentMount,
		onChange,
		onPending,
		onRetryable,
		prepareConfirmation,
		beginConfirmation
	});
	return {
		actions,
		beginConfirmation,
		confirm,
		contact,
		contactMount,
		form,
		initialize,
		launch,
		loadStripe,
		onChange,
		onPending,
		onRetryable,
		payment,
		paymentMount,
		prepareConfirmation,
		sdk,
		change(patch: Partial<StripeCheckoutSession>) {
			session = { ...session, ...patch };
			listener?.(session);
		}
	};
}

afterEach(() => vi.unstubAllGlobals());

describe('Checkout Elements browser boundary', () => {
	it('uses the site tokens and Poppins, and mounts the two Stripe-owned fields', async () => {
		const h = fixture();
		await vi.waitFor(() => expect(h.payment.mount).toHaveBeenCalledWith(h.paymentMount));
		expect(h.contact.mount).toHaveBeenCalledWith(h.contactMount);
		expect(h.loadStripe).toHaveBeenCalledWith(expect.stringMatching(/^pk_test_/));
		expect(h.initialize).toHaveBeenCalledWith({
			clientSecret: embeddedSecret,
			elementsOptions: {
				appearance: expect.objectContaining({
					variables: expect.objectContaining({
						colorPrimary: '#5f5b40',
						colorBackground: '#f6f1e4',
						fontFamily: 'Poppins, sans-serif',
						borderRadius: '10px'
					})
				}),
				fonts: [{ family: 'Poppins', src: expect.stringContaining('data:font/woff2;base64,') }]
			}
		});
		expect(h.actions.getSession).toHaveBeenCalled();
		expect(h.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ amount: 48000n }));
		await h.form.confirm();
		expect(h.prepareConfirmation).not.toHaveBeenCalled();
		h.form.stop();
		expect(h.contact.destroy).toHaveBeenCalledOnce();
		expect(h.payment.destroy).toHaveBeenCalledOnce();
	});

	it.each([
		{ currency: 'eur' },
		{ currency: undefined },
		{ currency: 840 },
		{ minorUnitsAmountDivisor: 1 },
		{ total: undefined },
		{ total: { total: { minorUnitsAmount: 48001 } } },
		{ total: { total: { minorUnitsAmount: 47999.99 } } }
	])('fails closed for an unverifiable total (%#)', async (patch) => {
		const h = fixture({ initial: { ...baseSession, ...patch } as StripeCheckoutSession });
		await vi.waitFor(() =>
			expect(h.onChange).toHaveBeenLastCalledWith({ kind: 'unavailable', reason: 'amount' })
		);
		expect(h.payment.mount).not.toHaveBeenCalled();
		await h.form.confirm();
		expect(h.confirm).not.toHaveBeenCalled();
	});

	it.each([
		{ minorUnitsAmountDivisor: 1000 },
		{ total: { ...baseSession.total, total: { minorUnitsAmount: 48001, amount: 'ignored' } } }
	])('rechecks the amount and validity after waiting for commerce (%#)', async (changedTotal) => {
		let allow!: (valid: boolean) => void;
		const preflight = new Promise<boolean>((resolve) => (allow = resolve));
		const h = fixture({ prepareConfirmation: vi.fn(() => preflight) });
		await vi.waitFor(() => expect(h.onChange).toHaveBeenCalled());
		h.change({ canConfirm: true });
		const submitting = h.form.confirm();
		await h.form.confirm();
		expect(h.prepareConfirmation).toHaveBeenCalledOnce();
		expect(h.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ submitting: true }));
		h.change(changedTotal);
		allow(true);
		await submitting;
		expect(h.confirm).not.toHaveBeenCalled();
		expect(h.payment.destroy).toHaveBeenCalledOnce();
		expect(h.onChange).toHaveBeenLastCalledWith({ kind: 'unavailable', reason: 'amount' });
	});

	it('tears down both fields when the Stripe Session expires while open', async () => {
		const h = fixture();
		await vi.waitFor(() => expect(h.onChange).toHaveBeenCalled());
		h.change({ canConfirm: true });
		h.change({ status: { type: 'expired' } });
		expect(h.onChange).toHaveBeenLastCalledWith({ kind: 'unavailable', reason: 'expired' });
		expect(h.contact.destroy).toHaveBeenCalledOnce();
		expect(h.payment.destroy).toHaveBeenCalledOnce();
		await h.form.confirm();
		expect(h.confirm).not.toHaveBeenCalled();
	});

	it('keeps the form available when Stripe identifies a field validation error before dispatch', async () => {
		const h = fixture();
		await vi.waitFor(() => expect(h.onChange).toHaveBeenCalled());
		h.change({ canConfirm: true });
		h.actions.validateElements.mockResolvedValueOnce({
			type: 'error',
			error: { message: 'Private details', code: 'validation_error', validation_errors: [] }
		});
		await h.form.confirm();
		expect(h.beginConfirmation).not.toHaveBeenCalled();
		expect(h.confirm).not.toHaveBeenCalled();
		expect(h.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ error: 'details' }));
		h.form.stop();
	});

	it.each(['success', 'decline', 'interrupted', 'null code', 'unknown code'] as const)(
		'handles %s without leaking provider details or dispatching twice',
		async (outcome) => {
			const h = fixture();
			await vi.waitFor(() => expect(h.onChange).toHaveBeenCalled());
			h.change({ canConfirm: true });
			const providerMessage = 'Private Stripe error with customer details';
			if (outcome === 'success')
				h.confirm.mockResolvedValue({ type: 'success', session: baseSession });
			else if (outcome === 'interrupted') h.confirm.mockRejectedValue(new Error(providerMessage));
			else if (outcome === 'null code')
				h.confirm.mockResolvedValue({
					type: 'error',
					error: { code: null, message: providerMessage }
				});
			else if (outcome === 'unknown code')
				h.confirm.mockResolvedValue({
					type: 'error',
					error: { code: 'futureCode', message: providerMessage }
				} as unknown as StripeCheckoutConfirmResult);
			else
				h.confirm.mockResolvedValue({
					type: 'error',
					error: {
						code: 'paymentFailed',
						message: providerMessage,
						paymentFailed: { declineCode: null }
					}
				});
			await Promise.all([h.form.confirm(), h.form.confirm()]);
			expect(h.beginConfirmation).toHaveBeenCalledOnce();
			expect(h.confirm).toHaveBeenCalledExactlyOnceWith({ redirect: 'if_required' });
			if (outcome === 'decline') {
				expect(h.onRetryable).toHaveBeenCalledOnce();
				expect(h.onChange).toHaveBeenLastCalledWith(
					expect.objectContaining({ error: 'declined', submitting: false })
				);
				expect(h.onPending).not.toHaveBeenCalled();
				expect(h.contact.destroy).not.toHaveBeenCalled();
				h.form.stop();
			} else {
				expect(h.onPending).toHaveBeenCalledExactlyOnceWith(
					outcome === 'success' ? 'submitted' : 'uncertain'
				);
				expect(h.contact.destroy).toHaveBeenCalledOnce();
				expect(h.payment.destroy).toHaveBeenCalledOnce();
				h.change({ status: { type: 'complete', paymentStatus: 'paid' } });
				expect(h.onPending).toHaveBeenCalledOnce();
			}
		}
	);

	it('observes Session completion while confirmation is in flight and ignores a later error', async () => {
		const h = fixture();
		await vi.waitFor(() => expect(h.onChange).toHaveBeenCalled());
		h.change({ canConfirm: true });
		let finish!: (result: StripeCheckoutConfirmResult) => void;
		h.confirm.mockReturnValue(new Promise((resolve) => (finish = resolve)));
		const confirming = h.form.confirm();
		await vi.waitFor(() => expect(h.confirm).toHaveBeenCalledOnce());
		h.change({ status: { type: 'complete', paymentStatus: 'unpaid' } });
		finish({ type: 'error', error: { code: null, message: 'Private error' } });
		await confirming;
		expect(h.onPending).toHaveBeenCalledExactlyOnceWith('submitted');
		expect(h.onRetryable).not.toHaveBeenCalled();
		expect(h.payment.destroy).toHaveBeenCalledOnce();
	});

	it('does not mount after disposal or act on a confirmation result from an invalidated launch', async () => {
		let release!: () => void;
		const h = fixture({ initialization: new Promise((resolve) => (release = resolve)) });
		await vi.waitFor(() => expect(h.loadStripe).toHaveBeenCalled());
		h.form.stop();
		release();
		await h.loadStripe.mock.results[0].value;
		expect(h.initialize).not.toHaveBeenCalled();
		expect(h.sdk.loadActions).not.toHaveBeenCalled();
		expect(h.contact.mount).not.toHaveBeenCalled();

		const second = fixture();
		await vi.waitFor(() => expect(second.onChange).toHaveBeenCalled());
		second.change({ canConfirm: true });
		let finish!: (result: StripeCheckoutConfirmResult) => void;
		second.confirm.mockReturnValue(new Promise((resolve) => (finish = resolve)));
		const submitting = second.form.confirm();
		await vi.waitFor(() => expect(second.confirm).toHaveBeenCalled());
		vi.mocked(second.launch.isCurrent).mockReturnValue(false);
		second.form.stop();
		finish({ type: 'success', session: baseSession });
		await submitting;
		expect(second.onPending).not.toHaveBeenCalled();
		expect(second.payment.destroy).toHaveBeenCalledOnce();
	});
});
