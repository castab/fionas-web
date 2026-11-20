import { backendConfig } from '$lib/server/config.js';
import { notificationResponse, revokeDevice } from '$lib/server/notifications.js';
import type { RequestHandler } from './$types';

/** Removes one of the staff member's devices (this one or another). Repeating it is harmless. */
export const DELETE: RequestHandler = async ({ params, request, url }) =>
	notificationResponse(
		await revokeDevice(
			backendConfig(url.origin),
			request.headers.get('cookie'),
			params.subscriptionId
		)
	);
