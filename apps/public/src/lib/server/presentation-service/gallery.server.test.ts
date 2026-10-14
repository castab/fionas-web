import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import { getGalleryPage, parseGalleryPage, trackGalleryEvent } from './gallery.server.js';

const rawItem = {
	id: 'post-1',
	mediaType: 'IMAGE',
	caption: 'A moment from the trailer.',
	permalink: 'https://www.instagram.com/p/Cabc123XYZ/',
	timestamp: '2026-08-01T00:00:00Z',
	mediaItems: [
		{
			mediaType: 'IMAGE',
			smallUrl: 'https://cdn.example.com/post-1/small.webp',
			largeUrl: 'https://cdn.example.com/post-1/large.webp',
			largeWidth: 600,
			largeHeight: 800,
			videoUrl: null,
			videoWidth: null,
			videoHeight: null,
			mediaUrlExpiresAt: '2026-08-01T06:00:00Z'
		}
	],
	viewCount: 0,
	clickCount: 0
};

function pagination(overrides: Partial<{ currentPage: number; totalPages: number }> = {}) {
	return {
		totalRecords: 1,
		currentPage: 1,
		totalPages: 1,
		links: { first: '/x?page=1', prev: null, self: '/x?page=1', next: null, last: '/x?page=1' },
		...overrides
	};
}

describe('presentation-service gallery parsing', () => {
	test('parses a well-formed gallery response', () => {
		expect(parseGalleryPage({ data: [rawItem], pagination: pagination() })).toEqual({
			tiles: [
				{
					id: 'post-1',
					mediaType: 'IMAGE',
					caption: 'A moment from the trailer.',
					permalink: 'https://www.instagram.com/p/Cabc123XYZ/',
					mediaItems: [
						{
							mediaType: 'IMAGE',
							smallUrl: 'https://cdn.example.com/post-1/small.webp',
							largeUrl: 'https://cdn.example.com/post-1/large.webp',
							largeWidth: 600,
							largeHeight: 800,
							videoUrl: null,
							videoWidth: null,
							videoHeight: null
						}
					]
				}
			],
			currentPage: 1,
			hasNextPage: false
		});
	});

	test("keeps every media item of a CAROUSEL_ALBUM post, in knurl's order, with each item's own mediaType", () => {
		const secondItem = {
			mediaType: 'VIDEO',
			smallUrl: 'https://cdn.example.com/post-1/1/small.webp',
			largeUrl: 'https://cdn.example.com/post-1/1/large.webp',
			largeWidth: 600,
			largeHeight: 800,
			videoUrl: 'https://cdn.example.com/post-1/1/original',
			videoWidth: 1080,
			videoHeight: 1920,
			mediaUrlExpiresAt: '2026-08-01T06:00:00Z'
		};
		const carousel = {
			...rawItem,
			id: 'post-carousel',
			mediaType: 'CAROUSEL_ALBUM',
			mediaItems: [rawItem.mediaItems[0], secondItem]
		};
		expect(parseGalleryPage({ data: [carousel], pagination: pagination() })?.tiles).toEqual([
			expect.objectContaining({
				id: 'post-carousel',
				mediaType: 'CAROUSEL_ALBUM',
				mediaItems: [
					{
						mediaType: 'IMAGE',
						smallUrl: rawItem.mediaItems[0].smallUrl,
						largeUrl: rawItem.mediaItems[0].largeUrl,
						largeWidth: 600,
						largeHeight: 800,
						videoUrl: null,
						videoWidth: null,
						videoHeight: null
					},
					{
						mediaType: 'VIDEO',
						smallUrl: secondItem.smallUrl,
						largeUrl: secondItem.largeUrl,
						largeWidth: 600,
						largeHeight: 800,
						videoUrl: secondItem.videoUrl,
						videoWidth: 1080,
						videoHeight: 1920
					}
				]
			})
		]);
	});

	test("keeps a VIDEO item whose asset hasn't finished processing (mediaType VIDEO, videoUrl still null)", () => {
		const processingVideo = { ...rawItem.mediaItems[0], mediaType: 'VIDEO', videoUrl: null };
		expect(
			parseGalleryPage({
				data: [{ ...rawItem, mediaItems: [processingVideo] }],
				pagination: pagination()
			})?.tiles
		).toEqual([
			expect.objectContaining({
				mediaItems: [
					{
						mediaType: 'VIDEO',
						smallUrl: processingVideo.smallUrl,
						largeUrl: processingVideo.largeUrl,
						largeWidth: 600,
						largeHeight: 800,
						videoUrl: null,
						videoWidth: null,
						videoHeight: null
					}
				]
			})
		]);
	});

	test('skips an individually malformed media item within a carousel rather than dropping the whole post', () => {
		const carousel = {
			...rawItem,
			id: 'post-carousel',
			mediaType: 'CAROUSEL_ALBUM',
			mediaItems: [rawItem.mediaItems[0], { videoUrl: null }]
		};
		expect(parseGalleryPage({ data: [carousel], pagination: pagination() })?.tiles).toEqual([
			expect.objectContaining({
				id: 'post-carousel',
				mediaItems: [expect.objectContaining({ smallUrl: rawItem.mediaItems[0].smallUrl })]
			})
		]);
	});

	test('drops a media item with a missing or invalid mediaType', () => {
		const carousel = {
			...rawItem,
			id: 'post-carousel',
			mediaType: 'CAROUSEL_ALBUM',
			mediaItems: [
				rawItem.mediaItems[0],
				{ ...rawItem.mediaItems[0], mediaType: undefined },
				{ ...rawItem.mediaItems[0], mediaType: 'GIF' }
			]
		};
		expect(parseGalleryPage({ data: [carousel], pagination: pagination() })?.tiles).toEqual([
			expect.objectContaining({
				mediaItems: [expect.objectContaining({ smallUrl: rawItem.mediaItems[0].smallUrl })]
			})
		]);
	});

	test('skips a post with no media items rather than failing the whole page', () => {
		expect(
			parseGalleryPage({
				data: [rawItem, { ...rawItem, id: 'post-2', mediaItems: [] }],
				pagination: pagination()
			})?.tiles
		).toEqual([expect.objectContaining({ id: 'post-1' })]);
	});

	test('derives hasNextPage from currentPage vs totalPages', () => {
		expect(
			parseGalleryPage({
				data: [rawItem],
				pagination: pagination({ currentPage: 1, totalPages: 3 })
			})
		).toEqual(expect.objectContaining({ currentPage: 1, hasNextPage: true }));

		expect(
			parseGalleryPage({
				data: [rawItem],
				pagination: pagination({ currentPage: 3, totalPages: 3 })
			})
		).toEqual(expect.objectContaining({ currentPage: 3, hasNextPage: false }));
	});

	test("rejects a payload that isn't shaped like a gallery response", () => {
		expect(parseGalleryPage({ notData: [] })).toBeNull();
		expect(parseGalleryPage({ data: [] })).toBeNull();
		expect(parseGalleryPage({ data: [], pagination: { currentPage: 1 } })).toBeNull();
		expect(parseGalleryPage(null)).toBeNull();
	});
});

describe('presentation-service gallery client', () => {
	const originalBaseUrl = process.env.PRESENTATION_SERVICE_BASE_URL;
	const originalAccountId = process.env.PRESENTATION_SERVICE_ACCOUNT_ID;
	const originalGalleryName = process.env.PRESENTATION_SERVICE_GALLERY_NAME;
	const originalToken = process.env.PRESENTATION_SERVICE_TRACKING_TOKEN;

	beforeEach(() => {
		process.env.PRESENTATION_SERVICE_BASE_URL = 'http://presentation-service.test';
		process.env.PRESENTATION_SERVICE_ACCOUNT_ID = 'acct-1';
		process.env.PRESENTATION_SERVICE_GALLERY_NAME = 'Madres Taco Shop';
		process.env.PRESENTATION_SERVICE_TRACKING_TOKEN = 'a-sufficiently-long-token';
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
	});

	afterEach(() => {
		process.env.PRESENTATION_SERVICE_BASE_URL = originalBaseUrl;
		process.env.PRESENTATION_SERVICE_ACCOUNT_ID = originalAccountId;
		process.env.PRESENTATION_SERVICE_GALLERY_NAME = originalGalleryName;
		process.env.PRESENTATION_SERVICE_TRACKING_TOKEN = originalToken;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	test('returns a page of tiles for a configured, reachable service', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(Response.json({ data: [rawItem], pagination: pagination() }))
		);

		await expect(getGalleryPage()).resolves.toEqual({
			tiles: [expect.objectContaining({ id: 'post-1' })],
			currentPage: 1,
			hasNextPage: false
		});
	});

	test("requests the configured gallery sorted by recency, leaving limit to knurl's own default", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(Response.json({ data: [rawItem], pagination: pagination() }));
		vi.stubGlobal('fetch', fetch);

		await getGalleryPage();

		const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
		expect(url.pathname).toBe('/api/v1/accounts/acct-1/galleries/by-name/Madres%20Taco%20Shop');
		expect(url.searchParams.get('sort')).toBe('recent');
		expect(url.searchParams.get('page')).toBe('1');
		expect(url.searchParams.has('limit')).toBe(false);
		expect(init.headers).toMatchObject({ authorization: 'Bearer a-sufficiently-long-token' });
	});

	test('requests the named landing gallery without changing the configured gallery', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(Response.json({ data: [rawItem], pagination: pagination() }));
		vi.stubGlobal('fetch', fetch);

		await getGalleryPage(1, 'landing');
		await getGalleryPage();

		expect((fetch.mock.calls[0][0] as URL).pathname).toBe(
			'/api/v1/accounts/acct-1/galleries/by-name/landing'
		);
		expect((fetch.mock.calls[1][0] as URL).pathname).toBe(
			'/api/v1/accounts/acct-1/galleries/by-name/Madres%20Taco%20Shop'
		);
	});

	test('returns no landing photos when the named gallery is unavailable', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(Response.json({ error: 'not_found' }, { status: 404 }))
		);
		await expect(getGalleryPage(1, 'landing')).resolves.toEqual({
			tiles: [],
			currentPage: 1,
			hasNextPage: false
		});
	});

	test('requests a later page by number when asked', async () => {
		const fetch = vi.fn().mockResolvedValue(
			Response.json({
				data: [rawItem],
				pagination: pagination({ currentPage: 3, totalPages: 3 })
			})
		);
		vi.stubGlobal('fetch', fetch);

		await getGalleryPage(3);

		const [url] = fetch.mock.calls[0] as [URL, RequestInit];
		expect(url.searchParams.get('page')).toBe('3');
	});

	test('returns an empty, terminal page, not a throw, when the gallery configuration is incomplete', async () => {
		delete process.env.PRESENTATION_SERVICE_GALLERY_NAME;
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);

		await expect(getGalleryPage()).resolves.toEqual({
			tiles: [],
			currentPage: 1,
			hasNextPage: false
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	test('returns an empty, terminal page when the service is unreachable', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));

		await expect(getGalleryPage()).resolves.toEqual({
			tiles: [],
			currentPage: 1,
			hasNextPage: false
		});
	});

	test('returns an empty, terminal page for a malformed success response', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ unexpected: true })));

		await expect(getGalleryPage()).resolves.toEqual({
			tiles: [],
			currentPage: 1,
			hasNextPage: false
		});
	});

	test('skips tracking entirely when no token is configured', async () => {
		delete process.env.PRESENTATION_SERVICE_TRACKING_TOKEN;
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);

		await trackGalleryEvent('post-1', 'view');
		expect(fetch).not.toHaveBeenCalled();
	});

	test('posts a tracking event with the bearer token, using the id resolved from the gallery name', async () => {
		process.env.PRESENTATION_SERVICE_TRACKING_TOKEN = 'a-sufficiently-long-token';
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					gallery: { id: 'resolved-gallery-id' },
					data: [],
					pagination: pagination()
				})
			)
			.mockResolvedValueOnce(Response.json({ status: 'ok' }))
			.mockResolvedValueOnce(Response.json({ status: 'ok' }));
		vi.stubGlobal('fetch', fetch);

		await trackGalleryEvent('post-1', 'click');
		await trackGalleryEvent('post-2', 'view');

		expect(fetch).toHaveBeenCalledTimes(3);

		const [resolveUrl] = fetch.mock.calls[0] as [URL, RequestInit];
		expect(resolveUrl.pathname).toBe(
			'/api/v1/accounts/acct-1/galleries/by-name/Madres%20Taco%20Shop'
		);
		expect(resolveUrl.searchParams.get('limit')).toBe('1');

		const [trackUrl, trackInit] = fetch.mock.calls[1] as [URL, RequestInit];
		expect(trackUrl.pathname).toBe('/api/v1/accounts/acct-1/galleries/resolved-gallery-id/track');
		expect(trackInit.headers).toMatchObject({ authorization: 'Bearer a-sufficiently-long-token' });
		expect(trackInit.body).toBe(JSON.stringify({ id: 'post-1', event: 'click' }));
		const [secondTrackUrl] = fetch.mock.calls[2] as [URL, RequestInit];
		expect(secondTrackUrl.pathname).toBe(trackUrl.pathname);
	});

	test('resolves and tracks the landing gallery independently', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ gallery: { id: 'landing-id' } }))
			.mockResolvedValueOnce(Response.json({ status: 'ok' }));
		vi.stubGlobal('fetch', fetch);

		await trackGalleryEvent('landing-post', 'view', 'landing');

		expect((fetch.mock.calls[0][0] as URL).pathname).toBe(
			'/api/v1/accounts/acct-1/galleries/by-name/landing'
		);
		expect((fetch.mock.calls[1][0] as URL).pathname).toBe(
			'/api/v1/accounts/acct-1/galleries/landing-id/track'
		);
		expect((fetch.mock.calls[1][1] as RequestInit).body).toBe(
			JSON.stringify({ id: 'landing-post', event: 'view' })
		);
	});

	test("skips tracking when the configured gallery name can't be resolved to an id", async () => {
		process.env.PRESENTATION_SERVICE_TRACKING_TOKEN = 'a-sufficiently-long-token';
		process.env.PRESENTATION_SERVICE_GALLERY_NAME = 'Unknown gallery';
		const fetch = vi.fn().mockResolvedValue(Response.json({ unexpected: true }));
		vi.stubGlobal('fetch', fetch);

		await trackGalleryEvent('post-1', 'view');

		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test('never throws when the resolve or tracking call fails', async () => {
		process.env.PRESENTATION_SERVICE_TRACKING_TOKEN = 'a-sufficiently-long-token';
		process.env.PRESENTATION_SERVICE_GALLERY_NAME = 'Unreachable gallery';
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));

		await expect(trackGalleryEvent('post-1', 'view')).resolves.toBeUndefined();
	});
});

test.each([0, -1, 1.5, Infinity])('rejects invalid media dimensions %s', (width) => {
	const post = { ...rawItem, mediaItems: [{ ...rawItem.mediaItems[0], largeWidth: width }] };
	expect(parseGalleryPage({ data: [post], pagination: pagination() })?.tiles).toEqual([]);
});

test('drops unsafe media and permalink URLs', () => {
	for (const post of [
		{ ...rawItem, permalink: 'javascript:alert(1)' },
		{ ...rawItem, mediaItems: [{ ...rawItem.mediaItems[0], smallUrl: 'file:///private' }] }
	])
		expect(parseGalleryPage({ data: [post], pagination: pagination() })?.tiles).toEqual([]);
});

test.each([0, -1, 1.5, Infinity])('rejects invalid pagination %s', (currentPage) => {
	expect(parseGalleryPage({ data: [rawItem], pagination: pagination({ currentPage }) })).toBeNull();
});
