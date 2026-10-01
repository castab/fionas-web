import { defineConfig, devices } from '@playwright/test';

const port = process.env.ADMIN_PLAYWRIGHT_PORT ?? '4174';
const stubPort = process.env.ADMIN_STUB_PORT ?? '4176';
const origin = `http://127.0.0.1:${port}`;
const stubUrl = `http://127.0.0.1:${stubPort}`;

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
				COMMERCE_STUB_TRUSTED_ORIGIN: origin
			}
		},
		{
			command: `npm run build && npm run preview -- --port ${port} --host 127.0.0.1`,
			url: origin,
			reuseExistingServer: !process.env.CI,
			timeout: 180_000,
			env: {
				COMMERCE_API_URL: stubUrl,
				ADMIN_ORIGIN: origin
			}
		}
	]
});
