/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />

/**
 * Staff Web Push only (docs/admin-push-notifications.md). There is deliberately no `fetch`
 * handler and no cache: admin pages and data are private and `no-store`, and must never be
 * served offline or from a stale copy.
 */
import { readPushConfig, PUSH_ROUTES } from '$lib/notifications.js';
import { clickTarget, notificationFor, parsePushPayload } from '$lib/push-notification.js';
import {
	base64UrlToBytes,
	clearStoredDevice,
	postEnrollment,
	readStoredDevice,
	writeStoredDevice
} from '$lib/push-device.js';

const sw = self as unknown as ServiceWorkerGlobalScope;

// Nothing is cached, so a new worker can take over at once.
sw.addEventListener('install', () => void sw.skipWaiting());
sw.addEventListener('activate', (event) => event.waitUntil(sw.clients.claim()));

sw.addEventListener('push', (event) => {
	let text: string | null;
	try {
		text = event.data?.text() ?? null;
	} catch {
		text = null;
	}
	const { title, options } = notificationFor(parsePushPayload(text));
	event.waitUntil(sw.registration.showNotification(title, options));
});

sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	event.waitUntil(openAdmin(clickTarget(event.notification.data)));
});

/** Focus an open admin window and navigate it, or open a new one. Only same-origin paths. */
async function openAdmin(path: string) {
	const target = new URL(path, sw.location.origin);
	if (target.origin !== sw.location.origin) return;
	const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
	const existing = windows.find((client) => new URL(client.url).origin === sw.location.origin);
	if (existing) {
		try {
			const focused = await existing.focus();
			await focused.navigate(target.href);
			return;
		} catch {
			// An uncontrolled window can't be navigated from here; open a fresh one instead.
		}
	}
	await sw.clients.openWindow(target.href);
}

/** Not in TypeScript's webworker lib yet. */
type SubscriptionChangeEvent = ExtendableEvent & {
	oldSubscription?: PushSubscription | null;
	newSubscription?: PushSubscription | null;
};

sw.addEventListener('pushsubscriptionchange', (event) => {
	const change = event as SubscriptionChangeEvent;
	change.waitUntil(resubscribe(change));
});

/**
 * The push service replaced or dropped this browser's subscription: subscribe again with the same
 * application server key and enroll it (the session cookie rides along on this same-origin call).
 * A signed-out browser (401) or another account's endpoint (409) is left alone.
 */
async function resubscribe(change: SubscriptionChangeEvent) {
	try {
		let subscription = change.newSubscription ?? null;
		if (!subscription) {
			let key = change.oldSubscription?.options.applicationServerKey ?? null;
			if (!key) {
				const response = await fetch(PUSH_ROUTES.config, { cache: 'no-store' });
				const config = response.ok ? readPushConfig(await response.json()) : null;
				if (!config?.enabled) return;
				key = base64UrlToBytes(config.vapidPublicKey).buffer;
			}
			subscription = await sw.registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: key
			});
		}
		const stored = await readStoredDevice();
		const outcome = await postEnrollment(subscription, stored?.label ?? null);
		if (outcome.ok)
			await writeStoredDevice({
				subscriptionId: outcome.device.subscriptionId,
				label: outcome.device.label
			});
		else if (outcome.failure.code === 'push_endpoint_in_use') await clearStoredDevice();
	} catch {
		// Best effort: the next page load re-enrolls whatever subscription the browser holds.
	}
}
