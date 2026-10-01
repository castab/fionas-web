import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	// hooks.server.ts already keeps signed-out visitors out; this narrows the type for the pages.
	if (!locals.user) redirect(303, '/login');
	return { user: locals.user };
};
