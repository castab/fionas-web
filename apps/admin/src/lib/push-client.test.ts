import { describe, expect, it } from 'vitest';
import { defaultDeviceLabel, pushSupport, within, type BrowserTraits } from './push-client.js';
import { base64UrlToBytes, sameServerKey } from './push-device.js';
import {
	normalizeLabel,
	notificationFailure,
	readPushDevice,
	readTestNotification,
	serviceLabel,
	testStatusCopy
} from './notifications.js';

const ua = {
	macChrome:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
	macSafari:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
	iphone:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
	windowsEdge:
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
	androidChrome:
		'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
	linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0'
};
const traits = (overrides: Partial<BrowserTraits>): BrowserTraits => ({
	userAgent: ua.macChrome,
	platform: 'MacIntel',
	maxTouchPoints: 0,
	standalone: false,
	serviceWorker: true,
	pushManager: true,
	notification: true,
	...overrides
});

describe('pushSupport', () => {
	it('supports capable desktop and Android browsers', () => {
		expect(pushSupport(traits({}))).toBe('supported');
		expect(
			pushSupport(
				traits({ userAgent: ua.androidChrome, platform: 'Linux armv8l', maxTouchPoints: 5 })
			)
		).toBe('supported');
		expect(pushSupport(traits({ pushManager: false }))).toBe('unsupported');
	});

	it('asks iPhone and iPad Safari to add the app to the Home Screen first', () => {
		const iphone = { userAgent: ua.iphone, platform: 'iPhone', maxTouchPoints: 5 };
		// Safari in a tab has no PushManager; it still gets the install guidance, not "unsupported".
		expect(pushSupport(traits({ ...iphone, pushManager: false }))).toBe('ios-install');
		expect(pushSupport(traits({ ...iphone, standalone: true }))).toBe('supported');
		expect(pushSupport(traits({ ...iphone, standalone: true, pushManager: false }))).toBe(
			'ios-update'
		);
		// iPadOS reports a Mac platform with touch.
		expect(pushSupport(traits({ userAgent: ua.macSafari, maxTouchPoints: 5 }))).toBe('ios-install');
	});
});

describe('defaultDeviceLabel', () => {
	it('names the browser and the device', () => {
		expect(defaultDeviceLabel(traits({}))).toBe('Chrome on Mac');
		expect(defaultDeviceLabel(traits({ userAgent: ua.macSafari }))).toBe('Safari on Mac');
		expect(defaultDeviceLabel(traits({ userAgent: ua.macSafari, maxTouchPoints: 5 }))).toBe(
			'Safari on iPad'
		);
		expect(defaultDeviceLabel(traits({ userAgent: ua.iphone, platform: 'iPhone' }))).toBe(
			'Safari on iPhone'
		);
		expect(defaultDeviceLabel(traits({ userAgent: ua.windowsEdge, platform: 'Win32' }))).toBe(
			'Edge on Windows'
		);
		expect(defaultDeviceLabel(traits({ userAgent: ua.androidChrome, platform: 'Linux' }))).toBe(
			'Chrome on Android'
		);
		expect(defaultDeviceLabel(traits({ userAgent: ua.linuxFirefox, platform: 'Linux' }))).toBe(
			'Firefox on Linux'
		);
		expect(defaultDeviceLabel(traits({ userAgent: 'curl/8', platform: '' }))).toBe('Browser');
	});
});

describe('within', () => {
	it('settles with the work, or the fallback on timeout or failure', async () => {
		expect(await within(Promise.resolve(1), 50, 0)).toBe(1);
		expect(await within(new Promise<number>(() => {}), 5, 0)).toBe(0);
		expect(await within(Promise.reject(new Error('x')), 50, 0)).toBe(0);
	});
});

describe('application server keys', () => {
	it('decodes base64url VAPID keys and compares them byte for byte', () => {
		const bytes = base64UrlToBytes('BOrJ_-A');
		expect([...bytes]).toEqual([0x04, 0xea, 0xc9, 0xff, 0xe0]);
		expect(sameServerKey(bytes.buffer, base64UrlToBytes('BOrJ_-A'))).toBe(true);
		expect(sameServerKey(bytes.buffer, base64UrlToBytes('BOrJ_-Q'))).toBe(false);
		expect(sameServerKey(null, bytes)).toBe(false);
	});
});

describe('notification contract helpers', () => {
	it('normalizes labels like commerce, at most 60 characters', () => {
		expect(normalizeLabel('  Front desk  ')).toBe('Front desk');
		expect(normalizeLabel('')).toBeNull();
		expect(normalizeLabel(undefined)).toBeNull();
		expect(normalizeLabel('x'.repeat(60))).toBe('x'.repeat(60));
		expect(normalizeLabel('x'.repeat(61))).toBeUndefined();
		expect(normalizeLabel('a\u0007b')).toBeUndefined();
	});

	it('never passes commerce messages through and keeps the codes the page branches on', () => {
		expect(notificationFailure(409, 'push_endpoint_in_use')).toEqual({
			status: 409,
			code: 'push_endpoint_in_use',
			message: 'This browser is still enrolled for another account.'
		});
		expect(notificationFailure(409, 'something_else').code).toBe('unavailable');
		expect(notificationFailure(503, 'unavailable').code).toBe('unavailable');
		expect(notificationFailure(502, null).status).toBe(503);
	});

	it('reads devices and tests strictly', () => {
		expect(readPushDevice({ subscriptionId: 'nope' })).toBeNull();
		expect(
			readTestNotification({
				notificationId: '1a5bd3fd-6a0a-4d2e-9a7c-3f8f0c2d9e41',
				subscriptionId: '6b1f0f8e-5a8e-4a9a-9d84-1f0a3c8f2b10',
				status: 'delivered',
				attempts: 1,
				queuedAt: 'x'
			})
		).toBeNull();
	});

	it('words every status plainly, and acceptance is never called display', () => {
		expect(testStatusCopy({ status: 'queued', failureReason: null })).toMatch(/Queued/);
		expect(testStatusCopy({ status: 'push_accepted', failureReason: null })).toMatch(
			/not that it was shown/
		);
		expect(testStatusCopy({ status: 'retrying', failureReason: 'provider_throttled' })).toMatch(
			/slow down/
		);
		expect(
			testStatusCopy({ status: 'push_failed', failureReason: 'subscription_expired' })
		).toMatch(/expired/);
		expect(testStatusCopy({ status: 'skipped', failureReason: 'subscription_revoked' })).toMatch(
			/removed/
		);
		expect(testStatusCopy({ status: 'push_failed', failureReason: 'novel_reason' })).toMatch(
			/didn’t take it/
		);
		expect(serviceLabel('APPLE')).toBe('Apple push service');
		expect(serviceLabel('SOMETHING')).toBe('Other push service');
	});
});
