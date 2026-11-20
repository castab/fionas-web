// Renders the admin web app icons from the brand badge (packages/ui/src/assets/logo-badge.svg)
// with headless Chromium, then writes them to apps/admin/static/icons/. Run from the repo root:
//   node apps/admin/scripts/render-icons.mjs
// The PNGs are committed; rerun only when the badge changes.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const root = new URL('../../../', import.meta.url);
const out = new URL('apps/admin/static/icons/', root);
const svg = await readFile(new URL('packages/ui/src/assets/logo-badge.svg', root), 'utf8');
const olive = '#5f5b40'; // --olive-700, the badge's own fill and the manifest theme color

/**
 * `scale` is the badge's share of the canvas; `background` fills it first (null keeps it
 * transparent). `mono` turns the badge into a white silhouette with the lettering knocked out,
 * for the Android status-bar badge, which only uses the alpha channel.
 */
const icons = [
	{ file: 'icon-192.png', size: 192, scale: 1, background: null },
	{ file: 'icon-512.png', size: 512, scale: 1, background: null },
	// Maskable: full-bleed olive, badge inside the 80% safe zone.
	{ file: 'icon-maskable-512.png', size: 512, scale: 0.8, background: olive },
	// iOS fills transparency with black, so the touch icon is full-bleed olive too.
	{ file: 'apple-touch-icon-180.png', size: 180, scale: 0.86, background: olive },
	{ file: 'badge-96.png', size: 96, scale: 1, background: null, mono: true }
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<!doctype html><html><body></body></html>');
await mkdir(out, { recursive: true });
for (const icon of icons) {
	const dataUrl = await page.evaluate(
		async ({ svg, icon }) => {
			const image = new Image();
			image.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
			await image.decode();
			const canvas = document.createElement('canvas');
			canvas.width = canvas.height = icon.size;
			const context = canvas.getContext('2d');
			if (icon.background) {
				context.fillStyle = icon.background;
				context.fillRect(0, 0, icon.size, icon.size);
			}
			const side = icon.size * icon.scale;
			const offset = (icon.size - side) / 2;
			context.drawImage(image, offset, offset, side, side);
			if (icon.mono) {
				const pixels = context.getImageData(0, 0, icon.size, icon.size);
				const d = pixels.data;
				for (let i = 0; i < d.length; i += 4) {
					// Olive (dark) stays as opaque white; cream lettering (light) becomes transparent.
					const light = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
					const keep = Math.max(0, Math.min(1, (0.75 - light) / 0.3));
					d[i] = d[i + 1] = d[i + 2] = 255;
					d[i + 3] = Math.round(d[i + 3] * keep);
				}
				context.putImageData(pixels, 0, 0);
			}
			return canvas.toDataURL('image/png');
		},
		{ svg, icon }
	);
	await writeFile(new URL(icon.file, out), Buffer.from(dataUrl.split(',')[1], 'base64'));
	console.log(`wrote static/icons/${icon.file}`);
}
await browser.close();
