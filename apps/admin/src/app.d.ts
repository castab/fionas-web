// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { StaffUser } from '$lib/server/auth.js';

declare global {
	/** package.json version, injected by vite.config.ts `define`. */
	const __APP_VERSION__: string;

	namespace App {
		// interface Error {}
		interface Locals {
			/** The signed-in staff member, resolved from the session cookie in hooks.server.ts. */
			user: StaffUser | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
