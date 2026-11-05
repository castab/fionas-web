/**
 * The browser boundary around official Stripe.js Embedded Checkout. Stripe renders and owns all
 * card entry in its own iframe; this module only loads Stripe.js on demand, mounts one instance
 * for an authorized launch, and tears it down. It never creates Checkout Sessions, chooses
 * amounts, or decides that money was received.
 *
 * The factory is injectable so tests (unit and Playwright) never need real Stripe.
 */

/** The parts of Stripe's `StripeEmbeddedCheckout` this page uses. */
export type EmbeddedInstance = {
	mount(element: HTMLElement): void;
	destroy(): void;
};

export type EmbeddedFactory = (
	publishableKey: string,
	options: { fetchClientSecret: () => Promise<string>; onComplete: () => void }
) => Promise<EmbeddedInstance>;

/** Why the form couldn't be shown. None of these touches the saved payment command. */
export type EmbeddedFailure = 'configuration' | 'load' | 'mount';

/** A Stripe publishable key (`pk_test_…` / `pk_live_…`). Secret or restricted keys never match. */
const PUBLISHABLE_KEY = /^pk_(test|live)_[A-Za-z0-9]{8,250}$/;

/** The configured publishable key, or null when it is missing or not a publishable key. */
export function readPublishableKey(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const key = value.trim();
	return PUBLISHABLE_KEY.test(key) ? key : null;
}

/**
 * Official Stripe.js, loaded from js.stripe.com on first use only (`/pure` defers the script
 * until here), so pages without an embedded payment never load it. Never bundled or self-hosted.
 */
export const stripeEmbeddedCheckout: EmbeddedFactory = async (publishableKey, options) => {
	const { loadStripe } = await import('@stripe/stripe-js/pure');
	const stripe = await loadStripe(publishableKey);
	if (!stripe) throw new Error('Stripe.js is not available.');
	return stripe.createEmbeddedCheckoutPage(options);
};

/**
 * Stripe allows one Embedded Checkout per page, so each start waits until the previous one has
 * been stopped and its (possibly still pending) initialization destroyed.
 */
let previousTeardown: Promise<void> = Promise.resolve();

export type EmbeddedStart = {
	factory: EmbeddedFactory;
	publishableKey: string | null;
	element: HTMLElement;
	/** The launch's in-memory capability; it rejects once the launch is no longer current. */
	clientSecret: () => Promise<string>;
	onComplete: () => void;
	onReady: () => void;
	onFailure: (failure: EmbeddedFailure) => void;
};

/**
 * Starts Embedded Checkout in `element` and returns `stop`, which destroys it. After `stop`,
 * nothing from this start can mount, complete or report: an initialization that resolves late is
 * destroyed unmounted. Errors are reported as a kind only; Stripe's error text is never logged
 * or shown (it could carry Session details).
 */
export function startEmbeddedCheckout(start: EmbeddedStart): () => void {
	let stopped = false;
	let instance: EmbeddedInstance | null = null;
	let signalStop!: () => void;
	const stoppedSignal = new Promise<void>((resolve) => (signalStop = resolve));
	const destroy = (target: EmbeddedInstance) => {
		try {
			target.destroy();
		} catch {
			// Already gone: nothing else to release.
		}
	};
	const waitFor = previousTeardown;
	const run = (async () => {
		await waitFor;
		if (stopped) return;
		if (!start.publishableKey) return start.onFailure('configuration');
		let created: EmbeddedInstance;
		try {
			created = await start.factory(start.publishableKey, {
				fetchClientSecret: start.clientSecret,
				onComplete: () => {
					if (!stopped) start.onComplete();
				}
			});
		} catch {
			if (!stopped) start.onFailure('load');
			return;
		}
		if (stopped) return destroy(created);
		try {
			created.mount(start.element);
		} catch {
			destroy(created);
			if (!stopped) start.onFailure('mount');
			return;
		}
		instance = created;
		start.onReady();
	})();
	previousTeardown = Promise.all([stoppedSignal, run.catch(() => undefined)]).then(() => undefined);
	return () => {
		if (stopped) return;
		stopped = true;
		if (instance) destroy(instance);
		instance = null;
		signalStop();
	};
}
