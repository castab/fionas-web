import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// Standalone Node server build (`node build/index.js`).
			// See https://svelte.dev/docs/kit/adapter-node for more information.
			adapter: adapter()
		})
	],
	test: {
		projects: [
			{
				// Server modules, actions and pure logic.
				extends: true,
				test: {
					name: 'server',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					environment: 'node'
				}
			},
			{
				// Components rendered in a real browser.
				extends: true,
				test: {
					name: 'client',
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					expect: { requireAssertions: true },
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					}
				}
			}
		]
	},
	server: { port: 5173 },
	preview: { port: 4173 }
});
