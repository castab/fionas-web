import type {
	Appearance,
	StripeCheckoutElementsSdk,
	StripeCheckoutElementsSdkOptions,
	StripeCheckoutLoadActionsSuccess,
	StripeCheckoutSession,
	StripeContactDetailsElement,
	StripePaymentElement
} from '@stripe/stripe-js';
import poppins from '@fontsource/poppins/files/poppins-latin-400-normal.woff2?inline';
import type { OnPageCheckoutLaunch } from './controller.js';

type ElementsOptions = NonNullable<StripeCheckoutElementsSdkOptions['elementsOptions']>;
type ElementsSdk = Pick<
	StripeCheckoutElementsSdk,
	'on' | 'loadActions' | 'createContactDetailsElement' | 'createPaymentElement'
>;
export type ElementsLoader = (key: string) => Promise<{
	initCheckoutElementsSdk(options: StripeCheckoutElementsSdkOptions): ElementsSdk;
}>;

const loadCheckoutStripe: ElementsLoader = async (key) => {
	const { loadStripe } = await import('@stripe/stripe-js/pure');
	const stripe = await loadStripe(key);
	if (!stripe) throw new Error('Stripe.js is not available.');
	return stripe;
};

function elementsOptions(element: HTMLElement): ElementsOptions {
	const style = getComputedStyle(element);
	// Resolve the site's tokens here. The Stripe frames have their own CSS environment.
	const token = (name: string) => style.getPropertyValue(name).trim();
	const appearance: Appearance = {
		theme: 'stripe',
		labels: 'above',
		variables: {
			colorPrimary: token('--brand'),
			colorBackground: token('--surface-card'),
			colorText: token('--text-body'),
			colorTextSecondary: token('--text-muted'),
			colorDanger: token('--rust-600'),
			fontFamily: token('--font-sans'),
			fontSizeBase: '16px',
			borderRadius: token('--radius-input'),
			spacingUnit: token('--space-1')
		},
		rules: {
			'.Input': { borderColor: token('--olive-500'), boxShadow: 'none' },
			'.Input:focus': {
				borderColor: token('--brand'),
				boxShadow: `0 0 0 2px ${token('--focus-ring')}`
			},
			'.Input--invalid': { borderColor: token('--rust-600') },
			'.Label': { color: token('--text-heading'), fontWeight: '500' },
			'.Error': { color: token('--rust-600') }
		}
	};
	// Reuse Fontsource's Latin Poppins asset. Inlining gives the Stripe frame the same bytes
	// without a cross-origin font request or a new font host.
	return { appearance, fonts: [{ family: 'Poppins', src: `url("${poppins}") format("woff2")` }] };
}

function verifiedTotal(session: StripeCheckoutSession, expected: bigint): bigint | null {
	const minorUnits = session.total?.total?.minorUnitsAmount;
	if (
		typeof session.currency !== 'string' ||
		session.currency.toLowerCase() !== 'usd' ||
		session.minorUnitsAmountDivisor !== 100 ||
		!Number.isSafeInteger(minorUnits) ||
		minorUnits <= 0
	)
		return null;
	const cents = BigInt(minorUnits);
	return cents === expected ? cents : null;
}

export type ElementsView =
	| { kind: 'loading' }
	| { kind: 'unavailable'; reason: 'load' | 'amount' | 'expired' }
	| {
			kind: 'ready';
			amount: bigint;
			canConfirm: boolean;
			submitting: boolean;
			error: 'declined' | 'details' | null;
	  };

type ElementsStart = {
	launch: OnPageCheckoutLaunch;
	publishableKey: string | null;
	contactMount: HTMLElement;
	paymentMount: HTMLElement;
	loadStripe?: ElementsLoader;
	onChange(view: ElementsView): void;
	prepareConfirmation(): Promise<boolean>;
	beginConfirmation(): boolean;
	onRetryable(): void;
	onPending(): void;
};

/** Owns one form. Only non-sensitive readiness, totals and fixed errors leave this boundary. */
export function startCheckoutElements(start: ElementsStart) {
	let stopped = false;
	let submitting = false;
	let contact: StripeContactDetailsElement | undefined;
	let payment: StripePaymentElement | undefined;
	let contactReady = false;
	let paymentReady = false;
	let actions: StripeCheckoutLoadActionsSuccess | undefined;
	let ready: Extract<ElementsView, { kind: 'ready' }> | null = null;
	// The Checkout SDK exposes on('change') with no unsubscribe. Disconnect the receiver on
	// teardown, and destroy both mounted Elements using their supported lifecycle API.
	const change = { receive: null as ((session: StripeCheckoutSession) => void) | null };
	const current = () => !stopped && start.launch.isCurrent();

	function stop() {
		if (stopped) return;
		stopped = true;
		change.receive = null;
		actions = undefined;
		ready = null;
		for (const element of [contact, payment]) {
			try {
				element?.destroy();
			} catch {
				// The frame may already have been removed by Stripe.
			}
		}
		contact = payment = undefined;
	}

	function fail(reason: Extract<ElementsView, { kind: 'unavailable' }>['reason']) {
		if (!current()) return;
		stop();
		start.onChange({ kind: 'unavailable', reason });
	}

	function pending() {
		if (!current()) return;
		stop();
		start.onPending();
	}

	function update(session: StripeCheckoutSession, error = ready?.error ?? null) {
		if (!current()) return;
		if (session.status?.type === 'complete') return pending();
		if (session.status?.type !== 'open') return fail('expired');
		const amount = verifiedTotal(session, start.launch.amountCents);
		if (amount === null) return fail('amount');
		if (contactReady && paymentReady) {
			ready = { kind: 'ready', amount, canConfirm: session.canConfirm === true, submitting, error };
			start.onChange(ready);
		}
	}

	function readSession() {
		if (!current() || !actions) return;
		try {
			update(actions.getSession());
		} catch {
			fail('load');
		}
	}

	void (async () => {
		if (!start.publishableKey) return fail('load');
		try {
			const stripe = await (start.loadStripe ?? loadCheckoutStripe)(start.publishableKey);
			if (!current()) return;
			const clientSecret = await start.launch.clientSecret();
			if (!current()) return;
			const sdk = stripe.initCheckoutElementsSdk({
				clientSecret,
				elementsOptions: elementsOptions(start.paymentMount)
			});
			const result = await sdk.loadActions();
			if (!current()) return;
			if (result.type !== 'success') return fail('load');
			actions = result.actions;
			readSession();
			if (!current()) return;
			change.receive = (session) => {
				// During confirmation Stripe may transition the Session before its promise resolves.
				if (!submitting) update(session);
			};
			sdk.on('change', (session) => change.receive?.(session));
			contact = sdk.createContactDetailsElement();
			payment = sdk.createPaymentElement();
			contact.on('loaderror', () => fail('load'));
			payment.on('loaderror', () => fail('load'));
			contact.on('ready', () => {
				contactReady = true;
				readSession();
			});
			payment.on('ready', () => {
				paymentReady = true;
				readSession();
			});
			contact.mount(start.contactMount);
			if (current()) payment?.mount(start.paymentMount);
		} catch {
			fail('load');
		}
	})();

	return {
		stop,
		async confirm() {
			if (!current() || !ready?.canConfirm || submitting || !actions) return;
			const checkout = actions;
			submitting = true;
			start.onChange({ ...ready, submitting, error: null });
			let error: 'declined' | 'details' | null = null;
			try {
				const validation = await checkout.validateElements();
				if (!current()) return;
				if (validation.type !== 'success') {
					error = 'details';
					return;
				}
				if (!(await start.prepareConfirmation()) || !current()) return;
				// Re-read after the network wait. Stripe tracks the validity of its own fields,
				// and the SDK may have changed the total or expired during the preflight.
				const session = checkout.getSession();
				update(session, null);
				if (!current() || !ready?.canConfirm || !start.beginConfirmation()) return;
				try {
					const result = await checkout.confirm({ redirect: 'if_required' });
					if (!current()) return;
					if (result.type === 'success' || result.error.code !== 'paymentFailed') return pending();
					start.onRetryable();
					error = 'declined';
				} catch {
					// Dispatch may have reached Stripe. Close and check the authoritative booking.
					pending();
				}
			} catch {
				fail('load');
			} finally {
				submitting = false;
				if (current() && ready) {
					ready = { ...ready, submitting, error };
					readSession();
				}
			}
		}
	};
}
