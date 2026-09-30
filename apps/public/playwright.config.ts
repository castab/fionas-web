import { defineConfig, devices } from '@playwright/test';

const port = process.env.PUBLIC_PLAYWRIGHT_PORT ?? '4173';

export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.e2e.{ts,js}',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		trace: 'on-first-retry'
	},
	projects: [
		{ name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
		{ name: 'mobile-chromium', use: { ...devices['Pixel 7'] } }
	],
	webServer: {
		command: `npm run build && npm run preview -- --port ${port} --host 127.0.0.1`,
		url: `http://127.0.0.1:${port}`,
		reuseExistingServer: !process.env.CI
	}
});
