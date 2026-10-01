import { redirect } from '@sveltejs/kit';
import { applySetCookies, logout } from '$lib/server/auth.js';
import { backendConfig } from '$lib/server/config.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, url, cookies }) => {
	const setCookies = await logout(backendConfig(url.origin), request.headers.get('cookie'));
	applySetCookies(cookies, setCookies);
	redirect(303, '/login');
};
