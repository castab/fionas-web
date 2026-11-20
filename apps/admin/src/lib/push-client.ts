/**
 * Browser-side staff push flows for the Notifications page and the signed-in shell: support
 * detection, enabling this device, re-enrolling on load, removal and the sign-out release. Every
 * network call goes to our own origin (`PUSH_ROUTES`), never to commerce.
 */
import {
	LABEL_MAX,
	PUSH_ROUTES,
	deviceRoute,
	readFailure,
	readPushConfig,
	readPushDevices,
	readTestNotification,
	readTestQueued,
	testStatusRoute,
	type NotificationFailure,
	type PushConfig,
	type PushDevice,
	type TestNotification,
	type TestQueued
} from './notifications.js';
import {
	base64UrlToBytes,
	clearStoredDevice,
	postEnrollment,
	readStoredDevice,
	sameServerKey,
	writeStoredDevice,
	type StoredDevice
} from './push-device.js';

export type PushSupport = 'supported' | 'unsupported' | 'ios-install' | 'ios-update';

export type BrowserTraits = {
	userAgent: string;
	platform: string;
	maxTouchPoints: number;
	standalone: boolean;
	serviceWorker: boolean;
	pushManager: boolean;
	notification: boolean;
};

/** iPhone, iPod or iPad (iPadOS reports a Mac platform with touch). */
export const isAppleMobile = (
	traits: Pick<BrowserTraits, 'userAgent' | 'platform' | 'maxTouchPoints'>
) =>
	/iPad|iPhone|iPod/.test(traits.userAgent) ||
	(traits.platform === 'MacIntel' && traits.maxTouchPoints > 1);

/**
 * Web Push on iOS/iPadOS only works in an installed Home Screen web app (16.4+), so Safari is told
 * to add it first rather than shown a button that can't work.
 */
export function pushSupport(traits: BrowserTraits): PushSupport {
	const capable = traits.serviceWorker && traits.pushManager && traits.notification;
	if (isAppleMobile(traits)) {
		if (!traits.standalone) return 'ios-install';
		return capable ? 'supported' : 'ios-update';
	}
	return capable ? 'supported' : 'unsupported';
}

/** "Chrome on Mac", "Safari on iPhone"… a starting point the staff member can edit. */
export function defaultDeviceLabel(
	traits: Pick<BrowserTraits, 'userAgent' | 'platform' | 'maxTouchPoints'>
): string {
	const ua = traits.userAgent;
	const browser = /Edg\//.test(ua)
		? 'Edge'
		: /Firefox\/|FxiOS\//.test(ua)
			? 'Firefox'
			: /OPR\//.test(ua)
				? 'Opera'
				: /CriOS\/|Chrome\//.test(ua)
					? 'Chrome'
					: /Safari\//.test(ua)
						? 'Safari'
						: 'Browser';
	const os = /iPhone|iPod/.test(ua)
		? 'iPhone'
		: /iPad/.test(ua) || (traits.platform === 'MacIntel' && traits.maxTouchPoints > 1)
			? 'iPad'
			: /Android/.test(ua)
				? 'Android'
				: /Mac OS X|Macintosh/.test(ua)
					? 'Mac'
					: /Windows/.test(ua)
						? 'Windows'
						: /CrOS/.test(ua)
							? 'Chromebook'
							: /Linux/.test(ua)
								? 'Linux'
								: null;
	return (os ? `${browser} on ${os}` : browser).slice(0, LABEL_MAX);
}

export function browserTraits(): BrowserTraits {
	const nav = navigator as Navigator & { standalone?: boolean };
	return {
		userAgent: nav.userAgent,
		platform: nav.platform ?? '',
		maxTouchPoints: nav.maxTouchPoints ?? 0,
		standalone: nav.standalone === true || matchMedia('(display-mode: standalone)').matches,
		serviceWorker: 'serviceWorker' in nav,
		pushManager: 'PushManager' in window,
		notification: 'Notification' in window
	};
}

/** Resolves with fallback if the work takes longer than `ms`. Never rejects. */
export function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(fallback), ms);
		work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(fallback);
			}
		);
	});
}

/** The service worker registration, once active (SvelteKit registers `/service-worker.js`). */
const registration = () =>
	within(
		navigator.serviceWorker.ready.then((ready) => ready as ServiceWorkerRegistration | null),
		10_000,
		null
	);

async function readConfig(): Promise<PushConfig | null> {
	try {
		const response = await fetch(PUSH_ROUTES.config, { cache: 'no-store' });
		return response.ok ? readPushConfig(await response.json()) : null;
	} catch {
		return null;
	}
}

export type DeviceSync =
	{ kind: 'enrolled'; device: StoredDevice } | { kind: 'not-enrolled' } | { kind: 'unavailable' };

let sync: Promise<DeviceSync> | null = null;

/**
 * Once per page load: when push is on, permission is granted and the browser holds a
 * subscription, enroll it again (same endpoint, same id; keys, expiry and label refresh). The
 * signed-in shell starts it without waiting; the Notifications page reads the same answer.
 * Another account's endpoint (409) is unsubscribed and forgotten, never re-enrolled silently.
 */
export function syncThisDevice(): Promise<DeviceSync> {
	sync ??= runSync();
	return sync;
}

async function runSync(): Promise<DeviceSync> {
	try {
		if (pushSupport(browserTraits()) !== 'supported' || Notification.permission !== 'granted')
			return { kind: 'not-enrolled' };
		const ready = await registration();
		const subscription = await ready?.pushManager.getSubscription();
		if (!subscription) {
			await clearStoredDevice();
			return { kind: 'not-enrolled' };
		}
		const config = await readConfig();
		if (!config?.enabled) return { kind: 'unavailable' };
		const stored = await readStoredDevice();
		const outcome = await postEnrollment(subscription, stored?.label ?? null);
		if (outcome.ok) {
			const device = { subscriptionId: outcome.device.subscriptionId, label: outcome.device.label };
			await writeStoredDevice(device);
			return { kind: 'enrolled', device };
		}
		if (outcome.failure.code === 'push_endpoint_in_use') {
			await subscription.unsubscribe().catch(() => false);
			await clearStoredDevice();
			return { kind: 'not-enrolled' };
		}
		return { kind: 'unavailable' };
	} catch {
		return { kind: 'unavailable' };
	}
}

export type EnableOutcome =
	| { ok: true; device: StoredDevice }
	| { ok: false; reason: 'blocked' | 'dismissed' | 'subscribe-failed' }
	| { ok: false; reason: 'enroll-failed'; failure: NotificationFailure };

/**
 * Call straight from the click: permission is requested before any other await, which iOS and
 * some browsers require for a user gesture.
 */
export async function enableThisDevice(
	vapidPublicKey: string,
	label: string | null
): Promise<EnableOutcome> {
	const permission = await Notification.requestPermission();
	if (permission === 'denied') return { ok: false, reason: 'blocked' };
	if (permission !== 'granted') return { ok: false, reason: 'dismissed' };
	const key = base64UrlToBytes(vapidPublicKey);
	const ready = await registration();
	if (!ready) return { ok: false, reason: 'subscribe-failed' };
	const subscribe = () =>
		ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
	let subscription: PushSubscription;
	try {
		const existing = await ready.pushManager.getSubscription();
		if (existing && sameServerKey(existing.options.applicationServerKey, key))
			subscription = existing;
		else {
			// A subscription made with another server key can't be reused (the key was rotated).
			await existing?.unsubscribe();
			subscription = await subscribe();
		}
	} catch {
		return { ok: false, reason: 'subscribe-failed' };
	}
	let outcome = await postEnrollment(subscription, label);
	if (!outcome.ok && outcome.failure.code === 'push_endpoint_in_use') {
		// Still enrolled for another account: get a fresh endpoint and enroll that instead.
		try {
			await subscription.unsubscribe();
			subscription = await subscribe();
		} catch {
			return { ok: false, reason: 'subscribe-failed' };
		}
		outcome = await postEnrollment(subscription, label);
	}
	if (!outcome.ok) return { ok: false, reason: 'enroll-failed', failure: outcome.failure };
	const device = { subscriptionId: outcome.device.subscriptionId, label: outcome.device.label };
	await writeStoredDevice(device);
	sync = Promise.resolve({ kind: 'enrolled', device });
	return { ok: true, device };
}

export type RemoveOutcome = { ok: true } | { ok: false; failure: NotificationFailure };

/** Removes any of the staff member's devices; for this one, also unsubscribes locally. */
export async function removeDevice(
	subscriptionId: string,
	thisDevice: boolean
): Promise<RemoveOutcome> {
	let response: Response;
	try {
		response = await fetch(deviceRoute(subscriptionId), { method: 'DELETE', cache: 'no-store' });
	} catch {
		return { ok: false, failure: readFailure(503, null) };
	}
	// 404: already gone for this account, which is what removal wanted.
	if (!response.ok && response.status !== 404)
		return {
			ok: false,
			failure: readFailure(response.status, await response.json().catch(() => null))
		};
	if (thisDevice) await forgetThisDevice();
	return { ok: true };
}

async function forgetThisDevice() {
	const ready = await within(
		navigator.serviceWorker.getRegistration().then((found) => found ?? null),
		2000,
		null
	);
	const subscription = await ready?.pushManager.getSubscription().catch(() => null);
	await subscription?.unsubscribe().catch(() => false);
	await clearStoredDevice();
	sync = Promise.resolve({ kind: 'not-enrolled' });
}

/**
 * Before signing out (best effort, bounded by the caller): remove this device from the account,
 * then unsubscribe, so the next person to sign in on this browser starts clean.
 */
export async function releaseThisDevice(): Promise<void> {
	if (!('serviceWorker' in navigator)) return;
	const stored = await readStoredDevice();
	if (stored) {
		await fetch(deviceRoute(stored.subscriptionId), { method: 'DELETE', cache: 'no-store' }).catch(
			() => null
		);
	}
	await forgetThisDevice();
}

export type TestSend =
	{ ok: true; queued: TestQueued } | { ok: false; failure: NotificationFailure };

/**
 * Queues a test with the click's key. An outage or lost answer is retried with the same key (the
 * same key returns the same test, so nothing is sent twice); anything else is final.
 */
export async function sendTest(
	subscriptionId: string,
	idempotencyKey: string,
	{ attempts = 3, pauseMs = 1500 } = {}
): Promise<TestSend> {
	let last: TestSend = { ok: false, failure: readFailure(503, null) };
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
		try {
			const response = await fetch(PUSH_ROUTES.test, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ subscriptionId, idempotencyKey }),
				cache: 'no-store'
			});
			const data: unknown = await response.json().catch(() => null);
			const queued = response.ok ? readTestQueued(data) : null;
			if (queued) return { ok: true, queued };
			last = { ok: false, failure: readFailure(response.ok ? 503 : response.status, data) };
		} catch {
			last = { ok: false, failure: readFailure(503, null) };
		}
		if (last.failure.code !== 'unavailable') return last;
	}
	return last;
}

export type TestRead =
	{ ok: true; test: TestNotification } | { ok: false; failure: NotificationFailure };

export async function readTest(notificationId: string): Promise<TestRead> {
	try {
		const response = await fetch(testStatusRoute(notificationId), { cache: 'no-store' });
		const data: unknown = await response.json().catch(() => null);
		const test = response.ok ? readTestNotification(data) : null;
		return test
			? { ok: true, test }
			: { ok: false, failure: readFailure(response.ok ? 503 : response.status, data) };
	} catch {
		return { ok: false, failure: readFailure(503, null) };
	}
}

export type DevicesRead =
	{ ok: true; devices: PushDevice[] } | { ok: false; failure: NotificationFailure };

export async function readDevices(): Promise<DevicesRead> {
	try {
		const response = await fetch(PUSH_ROUTES.subscriptions, { cache: 'no-store' });
		const data: unknown = await response.json().catch(() => null);
		const devices = response.ok ? readPushDevices(data) : null;
		return devices
			? { ok: true, devices }
			: { ok: false, failure: readFailure(response.ok ? 503 : response.status, data) };
	} catch {
		return { ok: false, failure: readFailure(503, null) };
	}
}
