import { createServer } from 'node:http';

// A small, dependency-free double for knurl's presentation-service, used only by
// Playwright. Serves a fixed gallery page for any account id and acknowledges
// tracking posts without asserting on the bearer token — e2e specs exercise the
// real fetch path against this instead of mocking `fetch` in-process.
const port = Number(process.env.PRESENTATION_SERVICE_MOCK_PORT ?? 4030);

const MEDIA_BASE = `http://127.0.0.1:${port}`;

// Two pages, so e2e specs can exercise Load More without a large fixture. Page one also
// carries a CAROUSEL_ALBUM post so the carousel dot-navigation flow can be exercised over a
// real HTTP fetch, not just mocked `fetch` in Vitest.
const galleryPages = [
	[
		{
			id: 'e2e-post-1',
			mediaType: 'IMAGE',
			caption: 'Soft serve and hand-scooped classics at a sunny backyard birthday party.',
			permalink: 'https://www.instagram.com/p/Cabc123XYZ/',
			timestamp: '2026-08-01T00:00:00Z',
			mediaItems: [
				{
					mediaType: 'IMAGE',
					smallUrl: `${MEDIA_BASE}/media/post-1/small.webp`,
					largeUrl: `${MEDIA_BASE}/media/post-1/large.webp`,
					largeWidth: 600,
					largeHeight: 800,
					videoUrl: null,
					videoWidth: null,
					videoHeight: null,
					mediaUrlExpiresAt: '2099-01-01T00:00:00Z'
				}
			],
			viewCount: 0,
			clickCount: 0
		},
		{
			id: 'e2e-post-carousel',
			mediaType: 'CAROUSEL_ALBUM',
			caption: 'A few favorite scoops from the party.',
			permalink: 'https://www.instagram.com/p/Cmno345PQR/',
			timestamp: '2026-08-01T12:00:00Z',
			mediaItems: [
				{
					mediaType: 'IMAGE',
					smallUrl: `${MEDIA_BASE}/media/post-carousel/0/small.webp`,
					largeUrl: `${MEDIA_BASE}/media/post-carousel/0/large.webp`,
					largeWidth: 600,
					largeHeight: 800,
					videoUrl: null,
					videoWidth: null,
					videoHeight: null,
					mediaUrlExpiresAt: '2099-01-01T00:00:00Z'
				},
				{
					mediaType: 'VIDEO',
					smallUrl: `${MEDIA_BASE}/media/post-carousel/1/small.webp`,
					largeUrl: `${MEDIA_BASE}/media/post-carousel/1/large.webp`,
					largeWidth: 600,
					largeHeight: 800,
					videoUrl: null,
					videoWidth: null,
					videoHeight: null,
					mediaUrlExpiresAt: '2099-01-01T00:00:00Z'
				},
				{
					mediaType: 'VIDEO',
					smallUrl: `${MEDIA_BASE}/media/post-carousel/2/small.webp`,
					largeUrl: `${MEDIA_BASE}/media/post-carousel/2/large.webp`,
					largeWidth: 600,
					largeHeight: 800,
					videoUrl: `${MEDIA_BASE}/media/post-carousel/2/original`,
					videoWidth: 1080,
					videoHeight: 1920,
					mediaUrlExpiresAt: '2099-01-01T00:00:00Z'
				}
			],
			viewCount: 0,
			clickCount: 0
		}
	],
	[
		{
			id: 'e2e-post-2',
			mediaType: 'VIDEO',
			caption: 'Guests choosing their favorite scoops at a backyard anniversary.',
			permalink: 'https://www.instagram.com/p/Cdef456UVW/',
			timestamp: '2026-08-02T00:00:00Z',
			mediaItems: [
				{
					mediaType: 'VIDEO',
					smallUrl: `${MEDIA_BASE}/media/post-2/small.webp`,
					largeUrl: `${MEDIA_BASE}/media/post-2/large.webp`,
					largeWidth: 600,
					largeHeight: 800,
					videoUrl: `${MEDIA_BASE}/media/post-2/original`,
					videoWidth: 1080,
					videoHeight: 1920,
					mediaUrlExpiresAt: '2099-01-01T00:00:00Z'
				}
			],
			viewCount: 0,
			clickCount: 0
		}
	]
];

const galleryName = 'Fionas Ice Cream';
const galleryId = 'e2e-gallery-uuid';
const landingGalleryName = 'landing';
const landingGalleryId = 'e2e-landing-gallery-uuid';
const landingPosts = [
	galleryPages[0][0],
	{
		...galleryPages[0][1],
		mediaItems: [
			galleryPages[0][1].mediaItems[0],
			galleryPages[0][1].mediaItems[1],
			{
				...galleryPages[0][1].mediaItems[0],
				largeUrl: `${MEDIA_BASE}/media/post-carousel/2/large.webp`
			}
		]
	},
	galleryPages[1][0]
];

function paginationFor(page) {
	const totalPages = galleryPages.length;
	return {
		totalRecords: galleryPages.flat().length,
		currentPage: page,
		totalPages,
		links: {
			first: '/api/v1/accounts/e2e/galleries/by-name/Fionas%20Ice%20Cream?page=1',
			prev:
				page > 1
					? `/api/v1/accounts/e2e/galleries/by-name/Fionas%20Ice%20Cream?page=${page - 1}`
					: null,
			self: `/api/v1/accounts/e2e/galleries/by-name/Fionas%20Ice%20Cream?page=${page}`,
			next:
				page < totalPages
					? `/api/v1/accounts/e2e/galleries/by-name/Fionas%20Ice%20Cream?page=${page + 1}`
					: null,
			last: `/api/v1/accounts/e2e/galleries/by-name/Fionas%20Ice%20Cream?page=${totalPages}`
		}
	};
}

function json(response, status, body) {
	response.writeHead(status, { 'content-type': 'application/json' });
	response.end(JSON.stringify(body));
}

const trackingEvents = [];
const server = createServer(async (request, response) => {
	const url = new URL(request.url, `http://${request.headers.host}`);

	if (url.pathname === '/__test__/health') {
		json(response, 200, { status: 'ok' });
		return;
	}

	if (url.pathname === '/__test__/tracking') {
		json(response, 200, trackingEvents);
		return;
	}
	if (url.pathname.startsWith('/media/')) {
		if (url.pathname.endsWith('/original')) {
			response.writeHead(404);
			response.end();
			return;
		}
		response.writeHead(200, { 'content-type': 'image/svg+xml' });
		response.end(
			'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="beige"/><circle cx="300" cy="350" r="150" fill="olive"/></svg>'
		);
		return;
	}
	const byNameMatch = url.pathname.match(
		/^\/api\/v1\/accounts\/[^/]+\/galleries\/by-name\/([^/]+)$/
	);
	if (request.method === 'GET' && byNameMatch) {
		if (request.headers.authorization !== 'Bearer e2e-presentation-service-tracking-token') {
			json(response, 401, { error: 'unauthorized' });
			return;
		}
		const requestedName = decodeURIComponent(byNameMatch[1]);
		if (requestedName === 'empty') {
			json(response, 200, { data: [], pagination: { currentPage: 1, totalPages: 1 } });
			return;
		}
		if (requestedName !== galleryName && requestedName !== landingGalleryName) {
			json(response, 404, { error: 'not_found' });
			return;
		}
		const isLanding = requestedName === landingGalleryName;
		const page = Math.min(
			Math.max(Number(url.searchParams.get('page') ?? '1') || 1, 1),
			isLanding ? 1 : galleryPages.length
		);
		json(response, 200, {
			gallery: {
				id: isLanding ? landingGalleryId : galleryId,
				name: requestedName,
				itemCount: isLanding ? landingPosts.length : galleryPages.flat().length,
				publishedCount: isLanding ? landingPosts.length : galleryPages.flat().length,
				createdAt: '2026-08-01T00:00:00Z',
				updatedAt: '2026-08-02T00:00:00Z'
			},
			data: isLanding ? landingPosts : galleryPages[page - 1],
			pagination: isLanding
				? { ...paginationFor(1), totalRecords: landingPosts.length, totalPages: 1 }
				: paginationFor(page)
		});
		return;
	}

	const trackMatch = url.pathname.match(/^\/api\/v1\/accounts\/[^/]+\/galleries\/([^/]+)\/track$/);
	if (request.method === 'POST' && trackMatch) {
		if (request.headers.authorization !== 'Bearer e2e-presentation-service-tracking-token') {
			json(response, 401, { error: 'unauthorized' });
			return;
		}
		// Only the id resolved from the by-name lookup is a valid track target — a caller that
		// posted the gallery *name* here (skipping resolution) would get a 404, same as knurl
		// would for an id that doesn't exist.
		if (trackMatch[1] !== galleryId && trackMatch[1] !== landingGalleryId) {
			json(response, 404, { error: 'not_found' });
			return;
		}
		let body = '';
		for await (const chunk of request) body += chunk;
		trackingEvents.push(JSON.parse(body));
		json(response, 200, { status: 'ok' });
		return;
	}

	json(response, 404, { error: 'not_found' });
});

server.listen(port, '127.0.0.1', () => {
	console.log('Presentation-service test double ready');
});
