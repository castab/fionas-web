import { json, redirect, type Handle } from '@sveltejs/kit';
import { getCurrentUser } from '$lib/server/auth.js';
import { backendConfig } from '$lib/server/config.js';

const LOGIN_PATH = '/login';
/**
 * Public routes besides /login: the passkey sign-in endpoints. They still resolve the user, because
 * a signed-in caller is re-authenticating ("Confirm it's you").
 */
const PUBLIC_ROUTES = new Set(['/(auth)/login/passkey', '/(auth)/login/passkey/options']);
/**
 * Same-origin JSON endpoints called with `fetch` (the Notifications page, the signed-in shell, the
 * service worker, and Account settings). Signed out, they answer a JSON 401 instead of an HTML
 * redirect to /login.
 */
const JSON_ROUTES = new Set([
	'/(app)/settings/notifications/config',
	'/(app)/settings/notifications/subscriptions',
	'/(app)/settings/notifications/subscriptions/[subscriptionId]',
	'/(app)/settings/notifications/test',
	'/(app)/settings/notifications/test/[notificationId]',
	'/(app)/settings/account/passkeys',
	'/(app)/settings/account/passkeys/options',
	'/(app)/settings/account/passkeys/[passkeyId]',
	'/(app)/settings/account/reauthenticate'
]);
/** Pages and endpoints whose answers (credentials, ceremonies, account details) are never cached. */
const NO_STORE_PREFIXES = ['/requests/', '/settings/account', '/login'];

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
	const routeId = event.route.id;
	if (!event.locals.user && routeId && JSON_ROUTES.has(routeId)) {
		return json(
			{ code: 'unauthenticated', message: 'Your session has ended. Sign in again.' },
			{ status: 401, headers: { 'cache-control': 'no-store' } }
		);
	}
	const isPublic = onLogin || (routeId !== null && PUBLIC_ROUTES.has(routeId));
	if (!event.locals.user && !isPublic) redirect(303, LOGIN_PATH);
	if (event.locals.user && onLogin) redirect(303, '/');

	const response = await resolve(event);
	// Includes enhanced action responses (which do not run page load). Reply bodies and recovery
	// keys must never enter a browser/shared cache, including on validation or UNKNOWN outcomes.
	const path = event.url.pathname;
	if (NO_STORE_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix)))
		response.headers.set('cache-control', 'no-store');
	if (path.startsWith('/requests/')) {
		// The only frame here is the sandboxed srcdoc email preview: it may never navigate anywhere.
		response.headers.set('content-security-policy', "frame-src 'none'");
	}
	return response;
};
