import { backendConfig } from '$lib/server/config.js';
import { notificationResponse, readNotificationConfig } from '$lib/server/notifications.js';
import type { RequestHandler } from './$types';

/** Whether staff push is on, and the VAPID public key the browser subscribes with. */
export const GET: RequestHandler = async ({ request, url }) =>
	notificationResponse(
		await readNotificationConfig(backendConfig(url.origin), request.headers.get('cookie'))
	);
