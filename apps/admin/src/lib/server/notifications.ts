import { json } from '@sveltejs/kit';
import { request, type ApiResult, type BackendConfig } from './backend.js';
import {
	TEST_KEY,
	UUID,
	normalizeLabel,
	notificationFailure,
	readPushConfig,
	readPushDevice,
	readPushDevices,
	readTestNotification,
	readTestQueued,
	type NotificationFailure,
	type PushConfig,
	type PushDevice,
	type TestNotification,
	type TestQueued
} from '$lib/notifications.js';

/**
 * The staff member's own Web Push devices and test sends (fionas-commerce
 * `/staff/notifications/*`). Every call acts as the signed-in staff member with their own session
 * cookie and the trusted Origin; none needs a Fiona permission. Responses are projected to known
 * fields; endpoints, keys and payloads never come back and are never logged here.
 */
export type NotificationResult<T> =
	{ ok: true; data: T; status: number } | ({ ok: false } & NotificationFailure);

export const notificationError = (status: number, code: string | null) => ({
	ok: false as const,
	...notificationFailure(status, code)
});

/** Exactly the fields of `PushSubscription.toJSON()` commerce needs, and an optional label. */
export type PushEnrollment = {
	subscription: {
		endpoint: string;
		expirationTime: number | null;
		keys: { p256dh: string; auth: string };
	};
	label: string | null;
};

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whitelists a browser enrollment body. Arbitrary browser JSON never reaches commerce: only the
 * https endpoint, the expiry and the two keys are copied, plus a normalized label. Commerce checks
 * the push host allow-list itself.
 */
export function parseEnrollment(body: unknown): PushEnrollment | null {
	if (!isRecord(body) || !isRecord(body.subscription)) return null;
	const { endpoint, expirationTime, keys } = body.subscription;
	const label = normalizeLabel(body.label);
	if (
		typeof endpoint !== 'string' ||
		endpoint.length > 2048 ||
		!endpoint.startsWith('https://') ||
		/\s/.test(endpoint) ||
		!(
			expirationTime === undefined ||
			expirationTime === null ||
			(typeof expirationTime === 'number' &&
				Number.isSafeInteger(expirationTime) &&
				expirationTime >= 0)
		) ||
		!isRecord(keys) ||
		typeof keys.p256dh !== 'string' ||
		typeof keys.auth !== 'string' ||
		keys.p256dh.length > 256 ||
		keys.auth.length > 64 ||
		!BASE64URL.test(keys.p256dh) ||
		!BASE64URL.test(keys.auth) ||
		label === undefined
	)
		return null;
	return {
		subscription: {
			endpoint,
			expirationTime: expirationTime ?? null,
			keys: { p256dh: keys.p256dh, auth: keys.auth }
		},
		label
	};
}

function project<T>(
	result: ApiResult<unknown>,
	read: (data: unknown) => T | null
): NotificationResult<T> {
	if (!result.ok) return notificationError(result.error.status, result.error.code);
	const data = read(result.data);
	// A success we can't read is treated like an outage, never passed through.
	return data === null
		? notificationError(503, 'unavailable')
		: { ok: true, data, status: result.status ?? 200 };
}

export async function readNotificationConfig(
	config: BackendConfig,
	cookie: string | null
): Promise<NotificationResult<PushConfig>> {
	return project(await request(config, '/staff/notifications/config', { cookie }), readPushConfig);
}

export async function enrollDevice(
	config: BackendConfig,
	cookie: string | null,
	enrollment: PushEnrollment
): Promise<NotificationResult<PushDevice>> {
	const { endpoint, expirationTime, keys } = enrollment.subscription;
	const json = {
		subscription: { endpoint, expirationTime, keys: { p256dh: keys.p256dh, auth: keys.auth } },
		...(enrollment.label && { label: enrollment.label })
	};
	return project(
		await request(config, '/staff/notifications/subscriptions', { method: 'POST', json, cookie }),
		readPushDevice
	);
}

export async function listDevices(
	config: BackendConfig,
	cookie: string | null
): Promise<NotificationResult<PushDevice[]>> {
	return project(
		await request(config, '/staff/notifications/subscriptions', { cookie }),
		readPushDevices
	);
}

export async function revokeDevice(
	config: BackendConfig,
	cookie: string | null,
	subscriptionId: string
): Promise<NotificationResult<null>> {
	if (!UUID.test(subscriptionId)) return notificationError(404, 'not_found');
	const result = await request(config, `/staff/notifications/subscriptions/${subscriptionId}`, {
		method: 'DELETE',
		cookie
	});
	return result.ok
		? { ok: true, data: null, status: 204 }
		: notificationError(result.error.status, result.error.code);
}

/** One key per click, reused for that click's retries: the same key returns the same test. */
export async function sendTestNotification(
	config: BackendConfig,
	cookie: string | null,
	subscriptionId: string,
	idempotencyKey: string
): Promise<NotificationResult<TestQueued>> {
	if (!UUID.test(subscriptionId) || !TEST_KEY.test(idempotencyKey))
		return notificationError(422, 'validation_failed');
	return project(
		await request(config, '/staff/notifications/test', {
			method: 'POST',
			json: { subscriptionId },
			cookie,
			capability: 'staffTestNotification',
			idempotencyKey
		}),
		readTestQueued
	);
}

export async function readTestStatus(
	config: BackendConfig,
	cookie: string | null,
	notificationId: string
): Promise<NotificationResult<TestNotification>> {
	if (!UUID.test(notificationId)) return notificationError(404, 'not_found');
	return project(
		await request(config, `/staff/notifications/${notificationId}`, { cookie }),
		readTestNotification
	);
}

const NO_STORE = { 'cache-control': 'no-store' };

/** The JSON answer for one of our endpoints: data or our own failure envelope, never cached. */
export function notificationResponse<T>(result: NotificationResult<T>): Response {
	if (!result.ok) {
		const { status, code, message } = result;
		return json({ code, message }, { status, headers: NO_STORE });
	}
	if (result.data === null) return new Response(null, { status: 204, headers: NO_STORE });
	return json(result.data, { status: result.status, headers: NO_STORE });
}

/** A JSON body, or null when it isn't one. */
export async function readBody(request: Request): Promise<unknown> {
	if (!request.headers.get('content-type')?.includes('application/json')) return null;
	return request.json().catch(() => null);
}
