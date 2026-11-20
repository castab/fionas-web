/**
 * What the service worker shows for a push, and where a click may go. Pure, so it is unit-tested
 * and imported by `src/service-worker.ts`. Payloads carry no customer data; commerce's contract is
 * docs/admin-push-notifications.md.
 */

export type PushPayload = {
	notificationId: string;
	kind: string;
	title: string;
	body: string;
	/** A same-origin relative path, already validated; null when absent or unsafe. */
	url: string | null;
};

export type ShownNotification = {
	title: string;
	options: {
		body: string;
		tag?: string;
		data: { url: string | null };
		icon: string;
		badge: string;
	};
};

export const NOTIFICATION_ICON = '/icons/icon-192.png';
export const NOTIFICATION_BADGE = '/icons/badge-96.png';
const FALLBACK = { title: 'Fiona’s Admin', body: 'Open Fiona’s admin for details.' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isLine = (value: unknown, max: number): value is string =>
	typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/**
 * A notification click target: only a path on the admin's own origin. It must start with one
 * `/` (not `//` or `/\`, which browsers treat as another host), carry no scheme, backslash,
 * whitespace or control character, and still resolve to the same origin.
 */
export function safeNotificationPath(value: unknown): string | null {
	if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
	if (!value.startsWith('/') || value[1] === '/' || value[1] === '\\') return null;
	if (/[\\\s\p{Cc}]/u.test(value)) return null;
	const base = 'https://admin.invalid';
	let resolved: URL;
	try {
		resolved = new URL(value, base);
	} catch {
		return null;
	}
	if (resolved.origin !== base) return null;
	return resolved.pathname + resolved.search + resolved.hash;
}

/** Version 1 payloads only; anything else is null (and still shown generically). */
export function parsePushPayload(text: string | null | undefined): PushPayload | null {
	if (!text || text.length > 4096) return null;
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	if (
		!isRecord(data) ||
		data.version !== 1 ||
		!isLine(data.notificationId, 128) ||
		!isLine(data.title, 200) ||
		!isLine(data.body, 500)
	)
		return null;
	return {
		notificationId: data.notificationId,
		kind: typeof data.kind === 'string' ? data.kind : 'unknown',
		title: data.title,
		body: data.body,
		url: safeNotificationPath(data.url)
	};
}

/**
 * Every push must show a notification (`userVisibleOnly`), so an unreadable one is generic. The
 * notification id is the tag: a duplicate delivery replaces the earlier one instead of stacking.
 */
export function notificationFor(payload: PushPayload | null): ShownNotification {
	const icons = { icon: NOTIFICATION_ICON, badge: NOTIFICATION_BADGE };
	if (!payload)
		return {
			title: FALLBACK.title,
			options: { body: FALLBACK.body, data: { url: null }, ...icons }
		};
	return {
		title: payload.title,
		options: {
			body: payload.body,
			tag: payload.notificationId,
			data: { url: payload.url },
			...icons
		}
	};
}

/** The click destination from a shown notification's data: a safe path, else the dashboard. */
export const clickTarget = (data: unknown): string =>
	(isRecord(data) && safeNotificationPath(data.url)) || '/';
