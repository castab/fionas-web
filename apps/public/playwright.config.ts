import { defineConfig, devices } from '@playwright/test';

// Two previews of one build: "gated" (BOOKING_ENABLED off, the default) and "booking" (on).
const gatedPort = process.env.PUBLIC_PLAYWRIGHT_PORT ?? '4173';
const bookingPort = process.env.PUBLIC_PLAYWRIGHT_BOOKING_PORT ?? '4175';
// Stand-in for the fionas-commerce API (see e2e/stub-commerce.mjs); the app reaches it server-side.
const stubPort = process.env.COMMERCE_STUB_PORT ?? '4174';
// The stub only answers the UI endpoints to this Bearer key, so the app must be sending it.
const stubKey = 'e2e-ui-key';

const gatedUrl = `http://127.0.0.1:${gatedPort}`;
const bookingUrl = `http://127.0.0.1:${bookingPort}`;
const bookingTests = '**/booking/**/*.e2e.{ts,js}';

const devices_ = {
	desktop: devices['Desktop Chrome'],
	mobile: devices['Pixel 7']
};

export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.e2e.{ts,js}',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	use: { trace: 'on-first-retry' },
	projects: [
		// Booking off: the landing page and the gated /book.
		...Object.entries(devices_).map(([name, device]) => ({
			name: `${name}-chromium`,
			testIgnore: bookingTests,
			use: { ...device, baseURL: gatedUrl }
		})),
		// Booking on: the form and the live CTAs.
		...Object.entries(devices_).map(([name, device]) => ({
			name: `${name}-chromium-booking`,
			testMatch: bookingTests,
			use: { ...device, baseURL: bookingUrl }
		}))
	],
	webServer: [
		{
			command: 'node e2e/stub-commerce.mjs',
			url: `http://127.0.0.1:${stubPort}/ready`,
			env: { COMMERCE_STUB_PORT: stubPort, COMMERCE_STUB_KEY: stubKey },
			reuseExistingServer: !process.env.CI
		},
		{
			command: `npm run build && npm run preview -- --port ${gatedPort} --host 127.0.0.1`,
			url: gatedUrl,
			env: {
				COMMERCE_API_URL: `http://127.0.0.1:${stubPort}`,
				FIONAS_UI_API_KEY: stubKey,
				BOOKING_ENABLED: 'false'
			},
			reuseExistingServer: !process.env.CI,
			timeout: 180_000
		},
		{
			command: `node e2e/start-booking-preview.mjs ${gatedUrl} ${bookingPort}`,
			url: bookingUrl,
			env: { COMMERCE_API_URL: `http://127.0.0.1:${stubPort}`, FIONAS_UI_API_KEY: stubKey },
			reuseExistingServer: !process.env.CI,
			timeout: 180_000
		}
	]
});
