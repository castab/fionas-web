import { redirect, type Handle } from '@sveltejs/kit';
import { getCurrentUser } from '$lib/server/auth.js';
import { backendConfig } from '$lib/server/config.js';

const LOGIN_PATH = '/login';

/**
 * Resolve the signed-in staff member on every request by forwarding the browser's session cookie to
 * the API's `/auth/me`, then keep signed-out visitors on the login page.
 */
export const handle: Handle = async ({ event, resolve }) => {
	event.locals.user = await getCurrentUser(
		backendConfig(event.url.origin),
		event.request.headers.get('cookie')
	);

	const onLogin = event.url.pathname === LOGIN_PATH;
	if (!event.locals.user && !onLogin) redirect(303, LOGIN_PATH);
	if (event.locals.user && onLogin) redirect(303, '/');

	return resolve(event);
};
