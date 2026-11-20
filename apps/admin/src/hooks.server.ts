import { json, redirect, type Handle } from '@sveltejs/kit';
import { getCurrentUser } from '$lib/server/auth.js';
import { backendConfig } from '$lib/server/config.js';

const LOGIN_PATH = '/login';
/**
 * The staff push JSON endpoints, called by the Notifications page, the signed-in shell and the
 * service worker. Signed out, they answer a JSON 401 instead of an HTML redirect to /login.
 */
const PUSH_JSON_ROUTES = new Set([
	'/(app)/settings/notifications/config',
	'/(app)/settings/notifications/subscriptions',
	'/(app)/settings/notifications/subscriptions/[subscriptionId]',
	'/(app)/settings/notifications/test',
	'/(app)/settings/notifications/test/[notificationId]'
]);

/**
 * Resolve the signed-in staff member on every request by forwarding the browser's session cookie to
 * the API's `/auth/me`, then keep signed-out visitors on the login page.
 */
export const handle: Handle = async ({ event, resolve }) => {
	// Only this GET endpoint delegates authentication to the actual SSE handshake. A failed
	// /auth/me must never redirect EventSource to HTML or misclassify an outage as sign-out.
	if (event.request.method === 'GET' && event.route.id === '/(app)/requests/[inquiryId]/updates') {
		event.locals.user = null;
		return resolve(event);
	}
	event.locals.user = await getCurrentUser(
		backendConfig(event.url.origin),
		event.request.headers.get('cookie')
	);

	const onLogin = event.url.pathname === LOGIN_PATH;
	if (!event.locals.user && event.route.id && PUSH_JSON_ROUTES.has(event.route.id)) {
		return json(
			{ code: 'unauthenticated', message: 'Your session has ended. Sign in again.' },
			{ status: 401, headers: { 'cache-control': 'no-store' } }
		);
	}
	if (!event.locals.user && !onLogin) redirect(303, LOGIN_PATH);
	if (event.locals.user && onLogin) redirect(303, '/');

	const response = await resolve(event);
	// Includes enhanced action responses (which do not run page load). Reply bodies and recovery
	// keys must never enter a browser/shared cache, including on validation or UNKNOWN outcomes.
	if (event.url.pathname.startsWith('/requests/')) {
		response.headers.set('cache-control', 'no-store');
		// The only frame here is the sandboxed srcdoc email preview: it may never navigate anywhere.
		response.headers.set('content-security-policy', "frame-src 'none'");
	}
	return response;
};
