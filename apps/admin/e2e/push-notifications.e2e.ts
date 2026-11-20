import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { signIn, stubUrl } from './request-helpers.js';
import { VAPID_PUBLIC_KEY } from './push-stub.mjs';

// Chromium's new headless mode: the old headless shell reports Notification.permission as
// "denied" even when granted, and can't show service worker notifications.
test.use({ channel: 'chromium' });

/**
 * Headless Chromium can't reach a real push service, so PushManager is replaced with a fake that
 * keeps its one subscription in localStorage (it survives reloads, like a real one) and records
 * unsubscribes. Everything else is real: the service worker, permissions, IndexedDB, our endpoints.
 */
async function fakePush(context: BrowserContext) {
	await context.grantPermissions(['notifications']);
	await context.addInitScript(() => {
		const KEY = '__fakePush';
		type Fake = { endpoint: string; key: number[]; n: number };
		const read = (): Fake | null => JSON.parse(localStorage.getItem(KEY) ?? 'null');
		const bytes = (key: BufferSource) =>
			key instanceof ArrayBuffer
				? new Uint8Array(key)
				: new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
		const make = (state: Fake | null) =>
			state && {
				endpoint: state.endpoint,
				expirationTime: null,
				options: { userVisibleOnly: true, applicationServerKey: Uint8Array.from(state.key).buffer },
				toJSON: () => ({
					endpoint: state.endpoint,
					expirationTime: null,
					keys: { p256dh: `BFakeKey${state.n}`, auth: `fakeAuth${state.n}` },
					extra: 'never forwarded'
				}),
				getKey: () => null,
				unsubscribe: async () => {
					localStorage.setItem(KEY, 'null');
					localStorage.setItem(
						'__fakeUnsubscribes',
						String(Number(localStorage.getItem('__fakeUnsubscribes') ?? 0) + 1)
					);
					return true;
				}
			};
		PushManager.prototype.getSubscription = async function () {
			return make(read()) as unknown as PushSubscription;
		};
		PushManager.prototype.subscribe = async function (options?: PushSubscriptionOptionsInit) {
			const existing = read();
			if (existing) return make(existing) as unknown as PushSubscription;
			const n = Number(localStorage.getItem('__fakeCount') ?? 0) + 1;
			localStorage.setItem('__fakeCount', String(n));
			const key = [...bytes(options!.applicationServerKey as BufferSource)];
			const state = { endpoint: `https://fcm.googleapis.com/fcm/send/e2e-${n}`, key, n };
			localStorage.setItem(KEY, JSON.stringify(state));
			return make(state) as unknown as PushSubscription;
		};
	});
}

type PushCall = {
	route: string;
	body?: { subscription?: { endpoint: string } } & Record<string, unknown>;
	key?: string;
};
type PushState = {
	devices: { subscriptionId: string; label?: string; revoked?: boolean }[];
	tests: Record<string, unknown>;
	calls: PushCall[];
};

const tokenCookie = async (context: BrowserContext) =>
	(await context.cookies()).map(({ name, value }) => `${name}=${value}`).join('; ');

async function push(
	context: BrowserContext,
	update?: unknown,
	cookie?: string
): Promise<PushState> {
	const headers = { cookie: cookie ?? (await tokenCookie(context)) };
	const response =
		update === undefined
			? await context.request.get(`${stubUrl}/__test/push`, { headers })
			: await context.request.post(`${stubUrl}/__test/push`, { headers, data: update });
	expect(response.ok()).toBe(true);
	return update === undefined ? response.json() : (null as unknown as PushState);
}

const enrollCalls = (state: PushState) =>
	state.calls.filter((call) => call.route === 'POST /staff/notifications/subscriptions');
const fakeSubscription = (page: Page) =>
	page.evaluate(() => JSON.parse(localStorage.getItem('__fakePush') ?? 'null')?.endpoint ?? null);

async function enable(page: Page, label?: string) {
	await page.goto('/settings/notifications');
	await expect(page.getByTestId('this-device-status')).toHaveText('Notifications off');
	if (label !== undefined) await page.getByLabel('Device name').fill(label);
	await page.getByTestId('enable-push').click();
	await expect(page.getByTestId('this-device-status')).toHaveText('Notifications on');
}

test('signed out, the push JSON routes answer 401 and the app shell assets are public', async ({
	playwright,
	baseURL
}) => {
	const request = await playwright.request.newContext({ baseURL });
	for (const path of [
		'/settings/notifications/config',
		'/settings/notifications/subscriptions',
		'/settings/notifications/test/1a5bd3fd-6a0a-4d2e-9a7c-3f8f0c2d9e41'
	]) {
		const response = await request.get(path, { maxRedirects: 0 });
		expect(response.status()).toBe(401);
		expect(response.headers()['cache-control']).toBe('no-store');
		expect(await response.json()).toMatchObject({ code: 'unauthenticated' });
	}
	expect((await request.get('/settings/notifications', { maxRedirects: 0 })).status()).toBe(303);
	for (const path of [
		'/service-worker.js',
		'/manifest.webmanifest',
		'/icons/icon-192.png',
		'/icons/icon-512.png',
		'/icons/icon-maskable-512.png',
		'/icons/apple-touch-icon-180.png'
	])
		expect((await request.get(path, { maxRedirects: 0 })).status(), path).toBe(200);
	const manifest = await (await request.get('/manifest.webmanifest')).json();
	expect(manifest).toMatchObject({
		name: "Fiona's Admin",
		start_url: '/',
		scope: '/',
		display: 'standalone'
	});
	await request.dispose();
});

test('push turned off in commerce shows a calm state and never asks for permission', async ({
	page,
	context
}) => {
	await fakePush(context);
	await signIn(page);
	await push(context, { mode: 'disabled' });
	// Reached from the account menu (the sidebar on desktop, the avatar menu on phones).
	const summary = page
		.getByRole('button', { name: 'Your account' })
		.or(page.getByLabel('Your account'));
	if (await summary.isVisible()) await summary.click();
	await page.getByTestId('notifications-link').filter({ visible: true }).click();
	await expect(page).toHaveURL('/settings/notifications');
	await expect(page.getByTestId('push-disabled')).toContainText('aren’t available yet');
	await expect(page.getByTestId('enable-push')).toHaveCount(0);
	const state = await push(context);
	expect(state.calls.map((call) => call.route)).toEqual(['GET /staff/notifications/config']);
});

test('enable enrolls only the whitelisted fields; reloads re-enroll and keep the id', async ({
	page,
	context
}) => {
	await fakePush(context);
	await signIn(page);
	await page.goto('/settings/notifications');
	// The label starts from the browser and device; the staff member can change it.
	await expect(page.getByLabel('Device name')).toHaveValue(/^Chrome on /);
	await enable(page, '  Front desk  ');
	await expect(page.getByTestId('this-device-label')).toContainText('Front desk');
	const rows = page.getByTestId('device');
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText('Front desk');
	await expect(rows.first()).toContainText('This device');
	await expect(rows.first().getByTestId('device-state')).toHaveText('Active');

	let state = await push(context);
	const [first] = enrollCalls(state);
	expect(first.body).toEqual({
		subscription: {
			endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-1',
			expirationTime: null,
			keys: { p256dh: 'BFakeKey1', auth: 'fakeAuth1' }
		},
		label: 'Front desk'
	});
	const id = state.devices[0].subscriptionId;

	// Every full page load re-enrolls once, with the remembered label, and the id stays.
	await page.goto('/');
	await expect.poll(async () => enrollCalls(await push(context)).length).toBe(2);
	await page.reload();
	await expect.poll(async () => enrollCalls(await push(context)).length).toBe(3);
	state = await push(context);
	expect(enrollCalls(state).at(-1)?.body).toMatchObject({ label: 'Front desk' });
	expect(state.devices.map((d) => d.subscriptionId)).toEqual([id]);
	await page.goto('/settings/notifications');
	await expect(page.getByTestId('this-device-status')).toHaveText('Notifications on');
	await expect(page.getByTestId('device')).toHaveCount(1);
});

test('a browser still enrolled for another account unsubscribes and enrolls a fresh endpoint', async ({
	page,
	context
}) => {
	await fakePush(context);
	await signIn(page);
	await page.goto('/settings/notifications');
	await expect(page.getByTestId('this-device-status')).toHaveText('Notifications off');
	const foreign = 'https://fcm.googleapis.com/fcm/send/someone-else';
	const key = [...Buffer.from(VAPID_PUBLIC_KEY, 'base64url')];
	await page.evaluate(
		({ foreign, key }) =>
			localStorage.setItem('__fakePush', JSON.stringify({ endpoint: foreign, key, n: 0 })),
		{ foreign, key }
	);
	await push(context, { foreignEndpoints: [foreign] });
	await page.getByTestId('enable-push').click();
	await expect(page.getByTestId('this-device-status')).toHaveText('Notifications on');
	const calls = enrollCalls(await push(context));
	expect(calls.map((call) => call.body?.subscription?.endpoint)).toEqual([
		foreign,
		'https://fcm.googleapis.com/fcm/send/e2e-1'
	]);
	expect(await fakeSubscription(page)).toBe('https://fcm.googleapis.com/fcm/send/e2e-1');
	await expect(page.getByTestId('device')).toHaveCount(1);
});

test('a lingering subscription of another account is dropped on load, never silently enrolled', async ({
	page,
	context
}) => {
	await fakePush(context);
	await signIn(page);
	const foreign = 'https://fcm.googleapis.com/fcm/send/someone-else';
	await push(context, { foreignEndpoints: [foreign] });
	await page.evaluate(
		({ foreign }) =>
			localStorage.setItem('__fakePush', JSON.stringify({ endpoint: foreign, key: [4], n: 0 })),
		{ foreign }
	);
	await page.goto('/settings/notifications');
	await expect(page.getByTestId('this-device-status')).toHaveText('Notifications off');
	expect(await fakeSubscription(page)).toBeNull();
	expect(enrollCalls(await push(context))).toHaveLength(1);
});

test('send test polls to push_accepted, reuses its key after a lost answer, and asks if it appeared', async ({
	page,
	context
}) => {
	await fakePush(context);
	await signIn(page);
	await enable(page);
	// The first answer is lost after commerce queued the test: the retry must reuse the key.
	await push(context, { loseTestAnswers: 1 });
	await page.getByTestId('send-test').click();
	await expect(page.getByTestId('test-status')).toContainText('Queued');
	await expect(page.getByTestId('test-outcome')).toContainText('not that it was shown', {
		timeout: 15_000
	});
	await page.getByRole('button', { name: 'Yes', exact: true }).click();
	await expect(page.getByTestId('test-status')).toContainText('This device is ready');

	let state = await push(context);
	const sends = state.calls.filter((call) => call.route === 'POST /staff/notifications/test');
	expect(sends).toHaveLength(2);
	expect(sends[0].key).toMatch(/^[0-9a-f-]{36}$/);
	expect(sends[1].key).toBe(sends[0].key);
	expect(sends[0].body).toEqual({ subscriptionId: state.devices[0].subscriptionId });
	expect(Object.keys(state.tests)).toHaveLength(1);

	// A new click is a new key; a terminal failure is worded plainly.
	await push(context, {
		plan: ['queued', 'retrying', 'push_failed'],
		failureReason: 'subscription_expired'
	});
	await page.getByTestId('send-test').click();
	await expect(page.getByTestId('test-status')).toContainText('Retrying', { timeout: 10_000 });
	await expect(page.getByTestId('test-outcome')).toContainText(
		'Not delivered: this device’s subscription has expired',
		{ timeout: 15_000 }
	);
	state = await push(context);
	const keys = state.calls
		.filter((call) => call.route === 'POST /staff/notifications/test')
		.map((call) => call.key);
	expect(new Set(keys).size).toBe(2);
	expect(JSON.stringify(await page.content())).not.toContain('PRIVATE');
});

test('remove another device, then this one (which also unsubscribes locally)', async ({
	page,
	context
}) => {
	await fakePush(context);
	await signIn(page);
	await enable(page, 'This laptop');
	const other = {
		subscriptionId: '7c2e1f9a-3b4d-4e5f-8a6b-9c0d1e2f3a4b',
		label: 'Office iPad',
		service: 'APPLE',
		state: 'EXPIRED',
		enrolledAt: '2026-11-01T17:00:00Z',
		refreshedAt: '2026-11-02T17:00:00Z',
		endpoint: 'https://web.push.apple.com/other'
	};
	const state = await push(context);
	await push(context, { devices: [...state.devices, other] });
	await page.reload();
	const rows = page.getByTestId('device');
	await expect(rows).toHaveCount(2);
	const otherRow = rows.filter({ hasText: 'Office iPad' });
	await expect(otherRow.getByTestId('device-state')).toHaveText('Expired');
	await otherRow.getByTestId('remove-device').click();
	await expect(rows).toHaveCount(1);
	await expect(page.getByTestId('this-device-status')).toHaveText('Notifications on');

	await rows.first().getByTestId('remove-device').click();
	await expect(page.getByTestId('no-devices')).toBeVisible();
	await expect(page.getByTestId('this-device-status')).toHaveText('Notifications off');
	expect(await fakeSubscription(page)).toBeNull();
	const after = await push(context);
	expect(after.calls.filter((call) => call.route.startsWith('DELETE'))).toHaveLength(2);
	expect(after.devices.every((device) => device.revoked)).toBe(true);
});

test('sign out removes this device and unsubscribes before the logout POST', async ({
	page,
	context
}) => {
	await fakePush(context);
	await signIn(page);
	await enable(page);
	const cookie = await tokenCookie(context);
	const summary = page.getByLabel('Your account');
	if (await summary.isVisible()) await summary.click();
	await page.getByRole('button', { name: 'Sign out' }).filter({ visible: true }).click();
	await expect(page).toHaveURL('/login');
	const state = await push(context, undefined, cookie);
	expect(state.calls.at(-1)?.route).toBe(
		`DELETE /staff/notifications/subscriptions/${state.devices[0].subscriptionId}`
	);
	expect(state.devices[0].revoked).toBe(true);
	expect(await fakeSubscription(page)).toBeNull();
	expect(
		await page.evaluate(
			() =>
				new Promise((resolve) => {
					const open = indexedDB.open('fionas-admin-push', 1);
					open.onsuccess = () => {
						const get = open.result.transaction('device').objectStore('device').get('this-device');
						get.onsuccess = () => resolve(get.result ?? null);
					};
				})
		)
	).toBeNull();
});

test('iPhone Safari is told to add the app to the Home Screen first', async ({ browser }) => {
	const context = await browser.newContext({
		userAgent:
			'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
		viewport: { width: 390, height: 844 },
		hasTouch: true
	});
	const page = await context.newPage();
	await signIn(page);
	await page.goto('/settings/notifications');
	await expect(page.getByTestId('ios-install')).toContainText('Add to Home Screen');
	await expect(page.getByTestId('enable-push')).toHaveCount(0);
	await context.close();
});

test('blocked notifications explain how to allow them instead of offering the button', async ({
	page,
	context
}) => {
	await fakePush(context);
	await context.addInitScript(() =>
		Object.defineProperty(Notification, 'permission', { get: () => 'denied' })
	);
	await signIn(page);
	await page.goto('/settings/notifications');
	await expect(page.getByTestId('push-blocked')).toBeVisible();
	await expect(page.getByTestId('enable-push')).toHaveCount(0);
});

test('the service worker shows a pushed payload, tagged by id, with only a safe click path', async ({
	page,
	context,
	baseURL
}) => {
	await context.grantPermissions(['notifications']);
	await signIn(page);
	const registrationId = await (async () => {
		const cdp = await context.newCDPSession(page);
		const found = new Promise<string>((resolve) =>
			cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
				const match = registrations.find((r: { scopeURL: string }) => r.scopeURL === `${baseURL}/`);
				if (match) resolve(match.registrationId);
			})
		);
		await cdp.send('ServiceWorker.enable');
		await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
		const id = await found;
		for (const [notificationId, url] of [
			['1a5bd3fd-6a0a-4d2e-9a7c-3f8f0c2d9e41', '/requests/0a6e8577-e811-487f-aa5d-3d30b74b25bd'],
			['2b6ce4fe-7b1b-4e3f-8b8d-4f9f1d3e0f52', 'https://evil.example/requests']
		])
			await cdp.send('ServiceWorker.deliverPushMessage', {
				origin: baseURL!,
				registrationId: id,
				data: JSON.stringify({
					version: 1,
					notificationId,
					kind: 'new_inquiry',
					title: 'New catering inquiry',
					body: 'Open Fiona’s admin to review it.',
					url
				})
			});
		await cdp.send('ServiceWorker.deliverPushMessage', {
			origin: baseURL!,
			registrationId: id,
			data: 'garbage'
		});
		return id;
	})();
	expect(registrationId).toBeTruthy();
	await expect
		.poll(() =>
			page.evaluate(async () =>
				(await (await navigator.serviceWorker.ready).getNotifications())
					.map((n) => ({ title: n.title, tag: n.tag, url: n.data?.url ?? null }))
					.sort((a, b) => a.tag.localeCompare(b.tag))
			)
		)
		.toEqual([
			{ title: 'Fiona’s Admin', tag: '', url: null },
			{
				title: 'New catering inquiry',
				tag: '1a5bd3fd-6a0a-4d2e-9a7c-3f8f0c2d9e41',
				url: '/requests/0a6e8577-e811-487f-aa5d-3d30b74b25bd'
			},
			{ title: 'New catering inquiry', tag: '2b6ce4fe-7b1b-4e3f-8b8d-4f9f1d3e0f52', url: null }
		]);
});
