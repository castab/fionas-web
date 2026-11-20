import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	enrollDevice,
	listDevices,
	notificationResponse,
	parseEnrollment,
	readNotificationConfig,
	readTestStatus,
	revokeDevice,
	sendTestNotification
} from './notifications.js';
import type { BackendConfig } from './backend.js';

const deviceId = '6b1f0f8e-5a8e-4a9a-9d84-1f0a3c8f2b10';
const notificationId = '1a5bd3fd-6a0a-4d2e-9a7c-3f8f0c2d9e41';
const device = {
	subscriptionId: deviceId,
	label: 'Front desk iPad',
	service: 'APPLE',
	state: 'ACTIVE',
	enrolledAt: '2026-11-18T17:02:11.204Z',
	refreshedAt: '2026-11-18T17:02:11.204Z'
};
const subscription = {
	endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
	expirationTime: null,
	keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQ', auth: 'tBHItJI5svbpez7KI4CCXg' }
};

type Call = { path: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[];
let answer: () => Response;
const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
	calls.push({
		path: new URL(url).pathname,
		method: init.method ?? 'GET',
		headers: Object.fromEntries(new Headers(init.headers).entries()),
		body: init.body === undefined ? undefined : JSON.parse(String(init.body))
	});
	return answer();
}) as unknown as typeof fetch;
const config: BackendConfig = {
	baseUrl: 'http://api.test',
	origin: 'https://admin.test',
	fetch: fakeFetch
};
const cookie = '__Host-fionas_session="s"; fionas_fe0=sealed';
const error = (status: number, code: string) =>
	Response.json({ code, message: 'PRIVATE commerce diagnostic' }, { status });

beforeEach(() => {
	calls = [];
	answer = () => Response.json({});
});

describe('parseEnrollment', () => {
	it('copies only the documented subscription fields and a normalized label', () => {
		const parsed = parseEnrollment({
			subscription: {
				...subscription,
				expirationTime: 1790000000000,
				keys: { ...subscription.keys, extra: 'x' },
				extra: 'x'
			},
			label: '  Front desk iPad  ',
			extra: { nested: true }
		});
		expect(parsed).toEqual({
			subscription: {
				endpoint: subscription.endpoint,
				expirationTime: 1790000000000,
				keys: subscription.keys
			},
			label: 'Front desk iPad'
		});
		expect(
			parseEnrollment({ subscription: { ...subscription, expirationTime: undefined } })
		).toEqual({
			subscription,
			label: null
		});
		expect(parseEnrollment({ subscription, label: '   ' })?.label).toBeNull();
	});

	it('rejects anything that is not a usable https subscription', () => {
		const invalid = [
			null,
			'text',
			{},
			{ subscription: { ...subscription, endpoint: 'http://fcm.googleapis.com/x' } },
			{ subscription: { ...subscription, endpoint: 'https://push.test/a b' } },
			{ subscription: { ...subscription, endpoint: `https://push.test/${'a'.repeat(2048)}` } },
			{ subscription: { ...subscription, expirationTime: -1 } },
			{ subscription: { ...subscription, expirationTime: '1790000000000' } },
			{ subscription: { ...subscription, keys: { p256dh: 'not base64!', auth: 'x' } } },
			{ subscription: { ...subscription, keys: { auth: 'x' } } },
			{ subscription, label: 'x'.repeat(61) },
			{ subscription, label: 'tab\there' },
			{ subscription, label: 42 }
		];
		for (const body of invalid) expect(parseEnrollment(body)).toBeNull();
	});
});

describe('staff notification calls', () => {
	it('reads the config as the staff member, projecting known fields', async () => {
		answer = () => Response.json({ enabled: true, vapidPublicKey: 'BOrJ5ZqX_-', extra: 1 });
		expect(await readNotificationConfig(config, cookie)).toEqual({
			ok: true,
			status: 200,
			data: { enabled: true, vapidPublicKey: 'BOrJ5ZqX_-' }
		});
		expect(calls[0]).toMatchObject({ path: '/staff/notifications/config', method: 'GET' });
		// The staff session goes to commerce; admin-local cookies never do.
		expect(calls[0].headers.cookie).toBe('__Host-fionas_session="s"');
		answer = () => Response.json({ enabled: false });
		expect(await readNotificationConfig(config, cookie)).toMatchObject({
			data: { enabled: false }
		});
		// Enabled without a key is unreadable, so it reads as unavailable.
		answer = () => Response.json({ enabled: true });
		expect(await readNotificationConfig(config, cookie)).toMatchObject({
			ok: false,
			status: 503,
			code: 'unavailable'
		});
	});

	it('enrolls with exactly the whitelisted body and the trusted Origin', async () => {
		answer = () => Response.json({ ...device, endpoint: 'leak' }, { status: 201 });
		const result = await enrollDevice(config, cookie, {
			subscription,
			label: 'Front desk iPad'
		});
		expect(result).toEqual({ ok: true, status: 201, data: { ...device, expirationTime: null } });
		expect(calls[0]).toMatchObject({
			path: '/staff/notifications/subscriptions',
			method: 'POST',
			headers: { origin: 'https://admin.test' },
			body: { subscription, label: 'Front desk iPad' }
		});
		expect(calls[0].headers['idempotency-key']).toBeUndefined();
		answer = () => Response.json(device);
		await enrollDevice(config, cookie, { subscription, label: null });
		expect(calls[1].body).toEqual({ subscription });
	});

	it('maps enrollment conflicts, validation and the disabled feature to our own copy', async () => {
		const cases = [
			[error(409, 'push_endpoint_in_use'), 409, 'push_endpoint_in_use'],
			[error(422, 'validation_failed'), 422, 'validation_failed'],
			[error(400, 'malformed_request'), 422, 'validation_failed'],
			[error(503, 'push_notifications_disabled'), 503, 'push_notifications_disabled'],
			[error(500, 'internal_failure'), 503, 'unavailable'],
			[error(401, 'unauthenticated'), 401, 'unauthenticated'],
			[error(403, 'forbidden'), 403, 'forbidden']
		] as const;
		for (const [response, status, code] of cases) {
			answer = () => response.clone();
			const result = await enrollDevice(config, cookie, { subscription, label: null });
			expect(result).toMatchObject({ ok: false, status, code });
			expect(JSON.stringify(result)).not.toContain('PRIVATE');
		}
	});

	it('lists devices and treats an unreadable list as unavailable', async () => {
		answer = () =>
			Response.json({
				devices: [
					device,
					{
						...device,
						subscriptionId: notificationId,
						state: 'EXPIRED',
						label: undefined,
						expirationTime: '2027-01-01T00:00:00Z'
					}
				]
			});
		const listed = await listDevices(config, cookie);
		expect(listed.ok && listed.data.map((d) => [d.state, d.label, d.expirationTime])).toEqual([
			['ACTIVE', 'Front desk iPad', null],
			['EXPIRED', null, '2027-01-01T00:00:00Z']
		]);
		answer = () => Response.json({ devices: [{ ...device, state: 'REVOKED' }] });
		expect(await listDevices(config, cookie)).toMatchObject({ ok: false, code: 'unavailable' });
		answer = () => error(503, 'push_notifications_disabled');
		expect(await listDevices(config, cookie)).toMatchObject({
			ok: false,
			code: 'push_notifications_disabled'
		});
	});

	it('revokes by id, and refuses an id that is not one without calling commerce', async () => {
		answer = () => new Response(null, { status: 204 });
		expect(await revokeDevice(config, cookie, deviceId)).toEqual({
			ok: true,
			status: 204,
			data: null
		});
		expect(calls[0]).toMatchObject({
			path: `/staff/notifications/subscriptions/${deviceId}`,
			method: 'DELETE',
			headers: { origin: 'https://admin.test' }
		});
		answer = () => error(404, 'not_found');
		expect(await revokeDevice(config, cookie, deviceId)).toMatchObject({
			status: 404,
			code: 'not_found'
		});
		expect(await revokeDevice(config, cookie, '../config')).toMatchObject({ status: 404 });
		expect(calls).toHaveLength(2);
	});

	it('sends a test with the browser key as the Idempotency-Key, validating both ids', async () => {
		answer = () => Response.json({ notificationId, status: 'queued' }, { status: 202 });
		expect(await sendTestNotification(config, cookie, deviceId, 'click-key_1')).toEqual({
			ok: true,
			status: 202,
			data: { notificationId, status: 'queued' }
		});
		expect(calls[0]).toMatchObject({
			path: '/staff/notifications/test',
			method: 'POST',
			headers: { 'idempotency-key': 'click-key_1', origin: 'https://admin.test' },
			body: { subscriptionId: deviceId }
		});
		for (const [id, key] of [
			[deviceId, 'bad key'],
			[deviceId, ''],
			[deviceId, 'k'.repeat(129)],
			['nope', 'click']
		])
			expect(await sendTestNotification(config, cookie, id, key)).toMatchObject({
				ok: false,
				status: 422,
				code: 'validation_failed'
			});
		expect(calls).toHaveLength(1);
		for (const [response, status, code] of [
			[error(409, 'IDEMPOTENCY_KEY_REUSED'), 409, 'IDEMPOTENCY_KEY_REUSED'],
			[error(404, 'not_found'), 404, 'not_found'],
			[error(503, 'push_notifications_disabled'), 503, 'push_notifications_disabled']
		] as const) {
			answer = () => response.clone();
			expect(await sendTestNotification(config, cookie, deviceId, 'click')).toMatchObject({
				ok: false,
				status,
				code
			});
		}
	});

	it('reads a test status, keeping only known fields', async () => {
		answer = () =>
			Response.json({
				notificationId,
				kind: 'test',
				subscriptionId: deviceId,
				status: 'push_failed',
				attempts: 2,
				queuedAt: '2026-11-18T17:02:11Z',
				lastAttemptAt: '2026-11-18T17:02:13Z',
				completedAt: '2026-11-18T17:02:13Z',
				failureReason: 'subscription_expired',
				providerCode: 410,
				endpoint: 'leak'
			});
		const read = await readTestStatus(config, cookie, notificationId);
		expect(read).toEqual({
			ok: true,
			status: 200,
			data: {
				notificationId,
				subscriptionId: deviceId,
				status: 'push_failed',
				attempts: 2,
				queuedAt: '2026-11-18T17:02:11Z',
				lastAttemptAt: '2026-11-18T17:02:13Z',
				completedAt: '2026-11-18T17:02:13Z',
				failureReason: 'subscription_expired',
				providerCode: 410
			}
		});
		expect(calls[0].path).toBe(`/staff/notifications/${notificationId}`);
		expect(await readTestStatus(config, cookie, 'config')).toMatchObject({ status: 404 });
		expect(calls).toHaveLength(1);
	});

	it('maps an unreachable commerce to unavailable', async () => {
		answer = () => {
			throw new TypeError('fetch failed');
		};
		expect(await listDevices(config, cookie)).toMatchObject({
			ok: false,
			status: 503,
			code: 'unavailable'
		});
	});
});

describe('notificationResponse', () => {
	it('answers no-store JSON, a bare 204, or our own failure envelope', async () => {
		const ok = notificationResponse({ ok: true, status: 201, data: { a: 1 } });
		expect(ok.status).toBe(201);
		expect(ok.headers.get('cache-control')).toBe('no-store');
		expect(await ok.json()).toEqual({ a: 1 });
		const empty = notificationResponse({ ok: true, status: 204, data: null });
		expect(empty.status).toBe(204);
		expect(empty.headers.get('cache-control')).toBe('no-store');
		const failed = notificationResponse({
			ok: false,
			status: 409,
			code: 'push_endpoint_in_use',
			message: 'This browser is still enrolled for another account.'
		});
		expect(failed.status).toBe(409);
		expect(failed.headers.get('cache-control')).toBe('no-store');
		expect(await failed.json()).toEqual({
			code: 'push_endpoint_in_use',
			message: 'This browser is still enrolled for another account.'
		});
	});
});
