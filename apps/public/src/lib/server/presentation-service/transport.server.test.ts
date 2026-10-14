import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import {
	presentationServiceAccountId,
	presentationServiceGalleryName,
	presentationServiceTrackingToken,
	readPresentationServiceJson,
	requestPresentationService
} from './transport.server.js';

describe('presentation-service server transport', () => {
	const originalBaseUrl = process.env.PRESENTATION_SERVICE_BASE_URL;
	const originalAccountId = process.env.PRESENTATION_SERVICE_ACCOUNT_ID;
	const originalGalleryName = process.env.PRESENTATION_SERVICE_GALLERY_NAME;
	const originalToken = process.env.PRESENTATION_SERVICE_TRACKING_TOKEN;

	beforeEach(() => {
		process.env.PRESENTATION_SERVICE_BASE_URL = 'http://presentation-service.test';
	});

	afterEach(() => {
		process.env.PRESENTATION_SERVICE_BASE_URL = originalBaseUrl;
		process.env.PRESENTATION_SERVICE_ACCOUNT_ID = originalAccountId;
		process.env.PRESENTATION_SERVICE_GALLERY_NAME = originalGalleryName;
		process.env.PRESENTATION_SERVICE_TRACKING_TOKEN = originalToken;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	test("keeps a caller's unauthenticated request credential-free and uncached", async () => {
		const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
		vi.stubGlobal('fetch', fetch);

		await requestPresentationService('/api/v1/accounts/acct/galleries/gallery', {
			operation: 'gallery.list',
			timeoutMs: 3_000
		});

		const init = fetch.mock.calls[0][1] as RequestInit;
		expect(init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error' });
		expect(init.headers).toMatchObject({ accept: 'application/json' });
		expect(init.headers).not.toHaveProperty('authorization');
	});

	test('forwards the bearer token only when the caller provides one', async () => {
		const fetch = vi.fn().mockResolvedValue(Response.json({ status: 'ok' }));
		vi.stubGlobal('fetch', fetch);

		await requestPresentationService('/api/v1/accounts/acct/galleries/gallery/track', {
			operation: 'gallery.track',
			method: 'POST',
			body: { id: 'post-1', event: 'view' },
			timeoutMs: 3_000,
			bearerToken: 'a-tracking-token'
		});

		const init = fetch.mock.calls[0][1] as RequestInit;
		expect(init.headers).toMatchObject({
			authorization: 'Bearer a-tracking-token',
			'content-type': 'application/json'
		});
		expect(init.body).toBe(JSON.stringify({ id: 'post-1', event: 'view' }));
	});

	test.each([
		'file:///tmp/presentation-service',
		'https://user:secret@presentation-service.test',
		'https://presentation-service.test/path',
		'https://presentation-service.test?target=other'
	])('rejects an unsafe base URL: %s', async (baseUrl) => {
		process.env.PRESENTATION_SERVICE_BASE_URL = baseUrl;
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		vi.spyOn(console, 'error').mockImplementation(() => undefined);

		await expect(
			requestPresentationService('/api/v1/accounts/acct/galleries/gallery', {
				operation: 'gallery.list',
				timeoutMs: 1_000
			})
		).resolves.toEqual({ ok: false, kind: 'misconfigured' });
		expect(fetch).not.toHaveBeenCalled();
	});

	test('classifies a timeout and never retries', async () => {
		const fetch = vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
		vi.stubGlobal('fetch', fetch);
		vi.spyOn(console, 'error').mockImplementation(() => undefined);

		await expect(
			requestPresentationService('/api/v1/accounts/acct/galleries/gallery', {
				operation: 'gallery.list',
				timeoutMs: 1
			})
		).resolves.toEqual({ ok: false, kind: 'timeout' });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test('accepts only bounded JSON responses', async () => {
		await expect(readPresentationServiceJson(new Response('{}'))).resolves.toBeNull();
		await expect(
			readPresentationServiceJson(Response.json({ value: 'large' }), 2)
		).resolves.toBeNull();
		await expect(readPresentationServiceJson(Response.json({ ok: true }))).resolves.toEqual({
			ok: true
		});
	});

	test('reads a trimmed account id and gallery name and rejects a short tracking token', () => {
		process.env.PRESENTATION_SERVICE_ACCOUNT_ID = '  acct-1  ';
		expect(presentationServiceAccountId()).toBe('acct-1');

		process.env.PRESENTATION_SERVICE_GALLERY_NAME = '  Madres Taco Shop  ';
		expect(presentationServiceGalleryName()).toBe('Madres Taco Shop');

		process.env.PRESENTATION_SERVICE_TRACKING_TOKEN = 'short';
		expect(presentationServiceTrackingToken()).toBeNull();

		process.env.PRESENTATION_SERVICE_TRACKING_TOKEN = 'a-sufficiently-long-token';
		expect(presentationServiceTrackingToken()).toBe('a-sufficiently-long-token');
	});
});

test('bounds streamed JSON even without a declared content length', async () => {
	const cancel = vi.fn();
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new Uint8Array(20));
		},
		cancel
	});
	expect(
		await readPresentationServiceJson(
			new Response(body, { headers: { 'content-type': 'application/json' } }),
			10
		)
	).toBeNull();
	expect(cancel).toHaveBeenCalledOnce();
});
