import { defineConfig, devices } from '@playwright/test';

/**
 * The customer payment suite (`/pay/{publicId}`), against a deterministic commerce stub. It needs
 * no NATS, Docker, Stripe account or merchant secrets: hosted Checkout is simulated in the browser
 * with routed `checkout.stripe.com` pages. Booking stays off; payments don't depend on it.
 */
const stubPort = process.env.PAYMENTS_STUB_PORT ?? '4031';
const port = process.env.PUBLIC_PLAYWRIGHT_PAYMENTS_PORT ?? '4177';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
	testDir: './e2e/payments',
	testMatch: '**/*.e2e.{ts,js}',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	use: { trace: 'on-first-retry', baseURL },
	projects: [
		{ name: 'desktop-chromium-payments', use: { ...devices['Desktop Chrome'] } },
		{ name: 'mobile-chromium-payments', use: { ...devices['Pixel 7'] } }
	],
	webServer: [
		{
			command: 'node e2e/payments/stub-commerce.mjs',
			url: `http://127.0.0.1:${stubPort}/__test__/health`,
			env: { PAYMENTS_STUB_PORT: stubPort },
			reuseExistingServer: false
		},
		{
			command: `npm run build && npm run preview -- --port ${port} --host 127.0.0.1`,
			url: baseURL,
			env: { BOOKING_ENABLED: 'false', COMMERCE_API_URL: `http://127.0.0.1:${stubPort}` },
			reuseExistingServer: !process.env.CI,
			timeout: 180_000
		}
	]
});
