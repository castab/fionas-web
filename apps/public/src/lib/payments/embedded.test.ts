import { describe, expect, it, vi } from 'vitest';
import {
	readPublishableKey,
	startEmbeddedCheckout,
	type EmbeddedFactory,
	type EmbeddedFailure
} from './embedded.js';

const flush = async () => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};
const key = 'pk_test_51FionasTestKey0123456789';
const element = {} as HTMLElement;

/** A Stripe.js stand-in whose initialization the test resolves or fails explicitly. */
function fakeStripe() {
	const log: string[] = [];
	const pending: {
		resolve: () => void;
		reject: (error: Error) => void;
		options: Parameters<EmbeddedFactory>[1];
	}[] = [];
	let instances = 0;
	let mountThrows = false;
	const factory: EmbeddedFactory = (publishableKey, options) => {
		log.push(`create:${publishableKey}`);
		return new Promise((resolve, reject) => {
			const n = ++instances;
			pending.push({
				options,
				reject,
				resolve: () =>
					resolve({
						mount: () => {
							if (mountThrows) throw new Error('cs_test_secret leaked in message');
							log.push(`mount:${n}`);
						},
						destroy: () => void log.push(`destroy:${n}`)
					})
			});
		});
	};
	return {
		factory,
		log,
		pending,
		failMounts: () => (mountThrows = true)
	};
}

function start(stripe: ReturnType<typeof fakeStripe>, publishableKey: string | null = key) {
	const events: string[] = [];
	const stop = startEmbeddedCheckout({
		factory: stripe.factory,
		publishableKey,
		element,
		clientSecret: () => Promise.resolve('cs_test_x_secret_y'),
		onComplete: () => void events.push('complete'),
		onReady: () => void events.push('ready'),
		onFailure: (kind: EmbeddedFailure) => void events.push(`failure:${kind}`)
	});
	return { stop, events };
}

describe('publishable key', () => {
	it('accepts only Stripe publishable keys', () => {
		expect(readPublishableKey(` ${key} `)).toBe(key);
		expect(readPublishableKey('pk_live_51FionasLiveKey0123456789')).toBe(
			'pk_live_51FionasLiveKey0123456789'
		);
		for (const bad of [
			undefined,
			'',
			'sk_test_51SecretKey0123456789',
			'rk_live_51Restricted0123456789',
			'whsec_123456789012345',
			'pk_test_short',
			'pk_test_has spaces 1234567'
		])
			expect(readPublishableKey(bad)).toBeNull();
	});
});

describe('Embedded Checkout lifecycle', () => {
	it('mounts once, forwards completion, and destroys on stop', async () => {
		const stripe = fakeStripe();
		const { stop, events } = start(stripe);
		await flush();
		stripe.pending[0].resolve();
		await flush();
		expect(stripe.log).toEqual([`create:${key}`, 'mount:1']);
		expect(events).toEqual(['ready']);
		await expect(stripe.pending[0].options.fetchClientSecret()).resolves.toBe('cs_test_x_secret_y');
		stripe.pending[0].options.onComplete();
		expect(events).toEqual(['ready', 'complete']);
		stop();
		stop();
		expect(stripe.log).toEqual([`create:${key}`, 'mount:1', 'destroy:1']);
		stripe.pending[0].options.onComplete(); // late callbacks after cleanup are ignored
		expect(events).toEqual(['ready', 'complete']);
	});

	it('L: an initialization that finishes after stop is destroyed, never mounted', async () => {
		const stripe = fakeStripe();
		const { stop, events } = start(stripe);
		await flush();
		stop();
		stripe.pending[0].resolve();
		await flush();
		expect(stripe.log).toEqual([`create:${key}`, 'destroy:1']);
		expect(events).toEqual([]);
	});

	it('runs one instance at a time: a remount waits for the previous teardown', async () => {
		const stripe = fakeStripe();
		const first = start(stripe);
		await flush();
		first.stop();
		const second = start(stripe);
		await flush();
		expect(stripe.pending).toHaveLength(1); // still waiting for the first to settle
		stripe.pending[0].resolve();
		await flush();
		expect(stripe.pending).toHaveLength(2);
		stripe.pending[1].resolve();
		await flush();
		expect(stripe.log).toEqual([`create:${key}`, 'destroy:1', `create:${key}`, 'mount:2']);
		expect(second.events).toEqual(['ready']);
		second.stop();
	});

	it('M: reports configuration, load and mount failures by kind only', async () => {
		const stripe = fakeStripe();
		const unconfigured = start(stripe, null);
		await flush();
		expect(unconfigured.events).toEqual(['failure:configuration']);
		expect(stripe.log).toEqual([]);
		unconfigured.stop();

		const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const load = start(stripe);
		await flush();
		stripe.pending[0].reject(new Error('Failed to load Stripe.js'));
		await flush();
		expect(load.events).toEqual(['failure:load']);
		load.stop();

		stripe.failMounts();
		const mount = start(stripe);
		await flush();
		stripe.pending[1].resolve();
		await flush();
		expect(mount.events).toEqual(['failure:mount']);
		expect(stripe.log.at(-1)).toBe('destroy:2');
		mount.stop();
		expect(errors).not.toHaveBeenCalled();
		errors.mockRestore();
	});
});
