import { defineConfig, devices } from '@playwright/test';

const port = process.env.ADMIN_PLAYWRIGHT_PORT ?? '4174';
const stubPort = process.env.ADMIN_STUB_PORT ?? '4176';
const origin = `http://127.0.0.1:${port}`;
const stubUrl = `http://127.0.0.1:${stubPort}`;
// WebAuthn never accepts an IP address as its RP ID, so the passkey specs use a second server on
// localhost, started from the same build (see e2e/passkeys.e2e.ts).
const passkeyPort = process.env.ADMIN_PASSKEY_PORT ?? '4175';
const passkeyOrigin = `http://localhost:${passkeyPort}`;

export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.e2e.{ts,js}',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	use: {
		baseURL: origin,
		trace: 'on-first-retry'
	},
	projects: [
		{ name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
		{ name: 'mobile-chromium', use: { ...devices['Pixel 7'] } }
	],
	webServer: [
		{
			// Stands in for the commerce API's /auth endpoints.
			command: 'node e2e/stub-commerce.mjs',
			url: `${stubUrl}/ready`,
			reuseExistingServer: !process.env.CI,
			env: {
				COMMERCE_STUB_PORT: stubPort,
				COMMERCE_STUB_TRUSTED_ORIGIN: origin,
				COMMERCE_STUB_PASSKEY_ORIGIN: passkeyOrigin
			}
		},
		{
			command: 'npm run build && node build/index.js',
			url: origin,
			reuseExistingServer: !process.env.CI,
			timeout: 180_000,
			env: {
				PORT: port,
				HOST: '127.0.0.1',
				ORIGIN: origin,
				COMMERCE_API_URL: stubUrl,
				ADMIN_ORIGIN: origin
			}
		},
		{
			// Starts after the build above (web servers start in order).
			command: 'node build/index.js',
			url: `http://127.0.0.1:${passkeyPort}`,
			reuseExistingServer: !process.env.CI,
			env: {
				PORT: passkeyPort,
				HOST: '127.0.0.1',
				ORIGIN: passkeyOrigin,
				COMMERCE_API_URL: stubUrl,
				ADMIN_ORIGIN: passkeyOrigin
			}
		}
	]
});
