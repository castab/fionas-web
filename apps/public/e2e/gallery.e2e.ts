import { expect, test } from '@playwright/test';

test('the gallery grid renders real posts, paginates with Load more, and opens a lightbox that keyboard navigation can drive', async ({
	page
}) => {
	await page.goto('/gallery');

	await expect(page.getByRole('heading', { level: 1 })).toHaveText(
		'a few favorites from recent events'
	);

	await expect(page.getByRole('button', { name: /View photo 1 of 2/ })).toBeVisible();
	await page.getByRole('button', { name: 'Load more' }).click();

	const cards = page.getByRole('button', { name: /View (photo|video|album) \d of 3/ });
	await expect(cards).toHaveCount(3);
	await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
	await expect(page.getByText(/caught up/i)).toBeVisible();

	await cards.first().click();
	await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'View on Instagram' })).toHaveAttribute(
		'href',
		'https://www.instagram.com/p/Cabc123XYZ/'
	);

	await page.keyboard.press('Escape');
	await expect(page.getByRole('button', { name: 'Close' })).toHaveCount(0);
});

test('a failed load more request shows an error and can be retried', async ({ page }) => {
	await page.goto('/gallery');
	await page.route(
		'**/gallery/load-more?page=2',
		async (route) => {
			await route.fulfill({ status: 503, body: 'Unavailable' });
		},
		{ times: 1 }
	);

	await page.getByRole('button', { name: 'Load more' }).click();
	await expect(page.getByRole('alert')).toHaveText("Couldn't load more photos. Please try again.");
	await expect(page.getByRole('button', { name: 'Load more' })).toBeEnabled();

	await page.getByRole('button', { name: 'Load more' }).click();
	await expect(page.getByRole('button', { name: /View (photo|video|album) \d of 3/ })).toHaveCount(
		3
	);
	await expect(page.getByRole('alert')).toHaveCount(0);
});

test('grid and lightbox loading spinners clear once each image settles, even on a failed load', async ({
	page
}) => {
	// Regression test: loadedThumbnailIds/loadedIds must be reactive Sets. A `$state(new
	// Set())` mutated via `.add()` silently doesn't trigger a re-render — every tile's
	// spinner (role="status") would stay visible forever, load or no load, error or not.
	await page.goto('/gallery');

	const spinners = page.locator('section [role="status"]');
	await expect(spinners).toHaveCount(0, { timeout: 10_000 });

	await page.getByRole('button', { name: /View photo 1 of 2/ }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	await expect(dialog.locator('[role="status"]')).toHaveCount(0, { timeout: 10_000 });
});

test("a carousel post's dots and chevrons move within it before paging to another post, and each slide's own media type drives its badge", async ({
	page
}) => {
	await page.goto('/gallery');

	await page.getByRole('button', { name: 'Load more' }).click();
	await expect(page.getByRole('button', { name: /View (photo|video|album) \d of 3/ })).toHaveCount(
		3
	);

	await page.getByRole('button', { name: /View album \d of 3/ }).click();
	const dialog = page.getByRole('dialog');
	const dots = dialog.getByRole('button', { name: /Go to image \d of 3/ });
	await expect(dots).toHaveCount(3);
	await expect(dots.first()).toHaveAttribute('aria-current', 'true');
	// Slide 1 is an image: no video badge, and no video 2 away is warmed yet.
	await expect(dialog.getByText(/Video/)).toHaveCount(0);
	await expect(dialog.locator('video')).toHaveCount(0);

	// Slide 2 is a VIDEO item with no videoUrl yet — its own mediaType (not the post's, which
	// is CAROUSEL_ALBUM) is what surfaces the processing badge, with no video element mounted
	// for slide 2 itself. Slide 3 (the ready video) is now the adjacent neighbor and gets
	// warmed (preload="auto", same buffering as a current slide) — one <video> exists, but
	// it isn't playing since it isn't current.
	await dots.nth(1).click();
	await expect(dots.nth(1)).toHaveAttribute('aria-current', 'true');
	await expect(dialog.getByText('Video · Processing')).toBeVisible();
	await expect(dialog.locator('video')).toHaveCount(1);
	await expect(dialog.locator('video[preload="auto"]')).toHaveCount(1);

	// Slide 3 is a ready VIDEO item: it becomes the current, playing video, and the badge
	// reads "Video" instead. Slide 2 (adjacent, but with no videoUrl) still mounts no <video>
	// at all, so it's the only video element in the DOM.
	await dots.nth(2).click();
	await expect(dots.nth(2)).toHaveAttribute('aria-current', 'true');
	await expect(dialog.getByText('Video', { exact: true })).toBeVisible();
	await expect(dialog.locator('video')).toHaveCount(1);

	// The fixture's videoUrl points at an unreachable host, so playback never actually starts
	// here — this only checks the controls exist and render an initial, un-started state
	// (real elapsed-time progression isn't exercised by this fixture-backed spec).
	await expect(dialog.getByRole('button', { name: 'Play video' })).toBeVisible();
	await expect(dialog.getByRole('slider', { name: 'Seek video' })).toBeVisible();
	await expect(dialog.getByText(/^\d+:\d{2}\/\d+:\d{2}$/)).toBeVisible();

	// Currently on the carousel's last slide (3 of 3). The Previous chevron traverses the
	// carousel back to its first slide before it pages to the previous post — the same rule
	// desktop/no-touch users get via keyboard, mirroring what touch users already get from
	// swiping.
	await dialog.getByRole('button', { name: 'Previous' }).click();
	await expect(dots.nth(1)).toHaveAttribute('aria-current', 'true');

	await dialog.getByRole('button', { name: 'Previous' }).click();
	await expect(dots.first()).toHaveAttribute('aria-current', 'true');

	await dialog.getByRole('button', { name: 'Previous' }).click();
	await expect(page.getByRole('link', { name: 'View on Instagram' })).toHaveAttribute(
		'href',
		'https://www.instagram.com/p/Cabc123XYZ/'
	);
});

test('gallery navigation, focus, and responsive header', async ({ page }) => {
	await page.goto('/');
	const nav = page.getByRole('navigation', { name: 'Main' });
	await expect(nav.getByRole('link', { name: 'Gallery' })).not.toHaveAttribute('aria-current');
	await nav.getByRole('link', { name: 'Gallery' }).click();
	await expect(nav.getByRole('link', { name: 'Gallery' })).toHaveAttribute('aria-current', 'page');
	const tile = page.getByRole('button', { name: /View photo 1 of 2/ });
	await tile.click();
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(dialog.getByRole('link', { name: 'View on Instagram' })).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
	await dialog.getByRole('button', { name: 'Next', exact: true }).click();
	await expect(dialog.getByRole('button', { name: /Go to image 1/ })).toHaveAttribute(
		'aria-current',
		'true'
	);
	await page.keyboard.press('Escape');
	await expect(tile).toBeFocused();
	await tile.click();
	await page.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(tile).toBeFocused();
	await page.setViewportSize({ width: 360, height: 780 });
	const mark = await page.locator('header svg').boundingBox();
	const gallery = await nav.getByRole('link', { name: 'Gallery' }).boundingBox();
	const book = await nav.getByRole('button', { name: 'Book', exact: true }).boundingBox();
	expect(mark?.height).toBe(42);
	expect(gallery!.x).toBeGreaterThanOrEqual(mark!.x + mark!.width);
	expect(book!.x + book!.width).toBeLessThanOrEqual(360);
	expect(Math.abs(gallery!.y - mark!.y)).toBeLessThan(2);
	const grid = page.getByRole('region', { name: 'Photos and videos' });
	expect(
		await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
	).toBe(2);
	await page.setViewportSize({ width: 1280, height: 900 });
	expect(
		await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
	).toBe(5);
});

test('lightbox tracking, muted video controls, and swipe navigation', async ({ page, request }) => {
	await page.goto('/gallery');
	await page.getByRole('button', { name: /View photo 1 of 2/ }).click();
	const dialog = page.getByRole('dialog');
	await dialog
		.getByRole('link', { name: 'View on Instagram' })
		.evaluate((el) => el.addEventListener('click', (event) => event.preventDefault()));
	await dialog.getByRole('link', { name: 'View on Instagram' }).click();
	const mockPort = process.env.PRESENTATION_SERVICE_MOCK_PORT ?? '4030';
	await expect
		.poll(async () => (await request.get(`http://127.0.0.1:${mockPort}/__test__/tracking`)).json())
		.toEqual(
			expect.arrayContaining([
				{ id: 'e2e-post-1', event: 'view' },
				{ id: 'e2e-post-1', event: 'click' }
			])
		);
	const media = dialog.locator('[data-media-scroll]');

	await media.evaluate((el) => {
		const start = new Touch({ identifier: 1, target: el, clientX: 200, clientY: 100 });
		el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [start] }));
		const end = new Touch({ identifier: 1, target: el, clientX: 100, clientY: 100 });
		el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [end] }));
	});
	await expect(dialog.getByRole('button', { name: /Go to image 1/ })).toHaveAttribute(
		'aria-current',
		'true'
	);
	await dialog.getByRole('button', { name: /Go to image 3/ }).click();
	await expect(dialog.getByRole('button', { name: 'Unmute video' })).toBeVisible();
	expect(await dialog.locator('video').evaluate((el) => el.muted)).toBe(true);
	await dialog.getByRole('button', { name: 'Unmute video' }).click();
	await expect(dialog.getByRole('button', { name: 'Mute video' })).toBeVisible();
	for (const control of await dialog.locator('button, input').all()) {
		const box = await control.boundingBox();
		expect(box!.height).toBeGreaterThanOrEqual(44);
		expect(box!.width).toBeGreaterThanOrEqual(44);
	}
	await page.keyboard.press('Escape');
});
