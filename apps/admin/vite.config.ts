import { readFileSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(version)
	},
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
	server: { port: 5174 },
	preview: { port: 4174 }
});
