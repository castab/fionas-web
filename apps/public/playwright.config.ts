import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { NATS_URL, WEB_USER } from './e2e/nats.js';

// Previews of one build: "gated" (BOOKING_ENABLED off, the default), "booking" (on) and "offline".
const gatedPort = process.env.PUBLIC_PLAYWRIGHT_PORT ?? '4173';
const bookingPort = process.env.PUBLIC_PLAYWRIGHT_BOOKING_PORT ?? '4175';
// A third preview with booking on but NATS unreachable (nothing listens on its port).
const offlinePort = process.env.PUBLIC_PLAYWRIGHT_OFFLINE_PORT ?? '4176';
// The booking preview publishes to a real NATS + JetStream (see e2e/global-setup.ts) as the
// least-privileged web user, with synthetic prices and a test-only replay secret.
const booking = {
	FIONAS_PRICES_FILE: fileURLToPath(
		new URL('./e2e/fixtures/prices.synthetic.yaml', import.meta.url)
	),
	FIONAS_REPLAY_SECRET: 'synthetic-test-only-replay-secret-32-bytes',
	NATS_URL,
	...WEB_USER
};

const gatedUrl = `http://127.0.0.1:${gatedPort}`;
const bookingUrl = `http://127.0.0.1:${bookingPort}`;
const offlineUrl = `http://127.0.0.1:${offlinePort}`;
const bookingTests = '**/booking/**/*.e2e.{ts,js}';
const offlineTests = '**/booking-offline/**/*.e2e.{ts,js}';

const devices_ = {
	desktop: devices['Desktop Chrome'],
	mobile: devices['Pixel 7']
};

export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.e2e.{ts,js}',
	globalSetup: './e2e/global-setup.ts',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	use: { trace: 'on-first-retry' },
	projects: [
		// Booking off: the landing page and the gated /book.
		...Object.entries(devices_).map(([name, device]) => ({
			name: `${name}-chromium`,
			testIgnore: [bookingTests, offlineTests],
			use: { ...device, baseURL: gatedUrl }
		})),
		// Booking on: the form and the live CTAs.
		...Object.entries(devices_).map(([name, device]) => ({
			name: `${name}-chromium-booking`,
			testMatch: bookingTests,
			use: { ...device, baseURL: bookingUrl }
		})),
		// Booking on, NATS unreachable: no form a customer can't send.
		{
			name: 'desktop-chromium-booking-offline',
			testMatch: offlineTests,
			use: { ...devices_.desktop, baseURL: offlineUrl }
		}
	],
	webServer: [
		{
			command: `npm run build && npm run preview -- --port ${gatedPort} --host 127.0.0.1`,
			url: gatedUrl,
			// No NATS settings: the marketing site must run without them while booking is off.
			env: { BOOKING_ENABLED: 'false' },
			reuseExistingServer: !process.env.CI,
			timeout: 180_000
		},
		{
			command: `node e2e/start-booking-preview.mjs ${gatedUrl} ${bookingPort}`,
			url: bookingUrl,
			env: booking,
			reuseExistingServer: !process.env.CI,
			timeout: 180_000
		},
		{
			command: `node e2e/start-booking-preview.mjs ${gatedUrl} ${offlinePort}`,
			url: offlineUrl,
			env: { ...booking, NATS_URL: 'nats://127.0.0.1:4299' },
			reuseExistingServer: !process.env.CI,
			timeout: 180_000
		}
	]
});
