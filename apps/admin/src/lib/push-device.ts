/**
 * "This device" for staff push, shared by the page, the signed-in shell and the service worker:
 * the locally remembered enrollment (IndexedDB, so the service worker can read it too; never a
 * cookie or server data) and the one same-origin call that enrolls a subscription.
 */
import {
	PUSH_ROUTES,
	readFailure,
	readPushDevice,
	type NotificationFailure,
	type PushDevice
} from './notifications.js';

export type StoredDevice = { subscriptionId: string; label: string | null };

const DB_NAME = 'fionas-admin-push';
const STORE = 'device';
const KEY = 'this-device';

function openStore(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const opening = indexedDB.open(DB_NAME, 1);
		opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
		opening.onsuccess = () => resolve(opening.result);
		opening.onerror = () => reject(opening.error);
	});
}

async function inStore<T>(
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
	const db = await openStore();
	try {
		return await new Promise<T>((resolve, reject) => {
			const request = run(db.transaction(STORE, mode).objectStore(STORE));
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	} finally {
		db.close();
	}
}

/** The remembered enrollment, or null (also when storage is unavailable). */
export async function readStoredDevice(): Promise<StoredDevice | null> {
	try {
		const value: unknown = await inStore('readonly', (store) => store.get(KEY));
		if (typeof value !== 'object' || value === null) return null;
		const { subscriptionId, label } = value as Record<string, unknown>;
		return typeof subscriptionId === 'string'
			? { subscriptionId, label: typeof label === 'string' ? label : null }
			: null;
	} catch {
		return null;
	}
}

export async function writeStoredDevice(device: StoredDevice): Promise<void> {
	try {
		await inStore('readwrite', (store) =>
			store.put({ subscriptionId: device.subscriptionId, label: device.label }, KEY)
		);
	} catch {
		// Best effort: without storage the page still works; it just can't mark "this device".
	}
}

export async function clearStoredDevice(): Promise<void> {
	try {
		await inStore('readwrite', (store) => store.delete(KEY));
	} catch {
		// Nothing to clear.
	}
}

export type EnrollOutcome =
	{ ok: true; device: PushDevice } | { ok: false; failure: NotificationFailure };

/**
 * Enrolls a subscription with the staff member's session. Commerce keeps the id for the same
 * endpoint and replaces the label, so re-enrollment always resends the remembered label.
 */
export async function postEnrollment(
	subscription: PushSubscription,
	label: string | null
): Promise<EnrollOutcome> {
	let response: Response;
	try {
		response = await fetch(PUSH_ROUTES.subscriptions, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({ subscription: subscription.toJSON(), label }),
			credentials: 'same-origin',
			cache: 'no-store'
		});
	} catch {
		return { ok: false, failure: readFailure(503, null) };
	}
	const data: unknown = await response.json().catch(() => null);
	if (!response.ok) return { ok: false, failure: readFailure(response.status, data) };
	const device = readPushDevice(data);
	return device ? { ok: true, device } : { ok: false, failure: readFailure(503, null) };
}

/** A base64url VAPID key as the bytes `pushManager.subscribe` expects. */
export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
	const base64 = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Whether a subscription was made with this application server key (false when unknown). */
export function sameServerKey(current: ArrayBuffer | null | undefined, key: Uint8Array): boolean {
	if (!current) return false;
	const bytes = new Uint8Array(current);
	return bytes.length === key.length && bytes.every((byte, i) => byte === key[i]);
}
