import { redirect } from '@sveltejs/kit';
import { readStaffAccount, takePasskeyNudge } from '$lib/server/account.js';
import { backendConfig } from '$lib/server/config.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, cookies, request, url }) => {
	// hooks.server.ts already keeps signed-out visitors out; this narrows the type for the pages.
	if (!locals.user) redirect(303, '/login');
	// Right after a password sign-in only: suggest a passkey when the account has none yet. A
	// failed read just skips the suggestion.
	let passkeyNudge = false;
	if (takePasskeyNudge(cookies)) {
		const account = await readStaffAccount(
			backendConfig(url.origin),
			request.headers.get('cookie')
		);
		passkeyNudge = account.ok && account.data.passkeyCount === 0;
	}
	return { user: locals.user, passkeyNudge };
};
