import { backendConfig } from '$lib/server/config.js';
import { notificationResponse, readTestStatus } from '$lib/server/notifications.js';
import type { RequestHandler } from './$types';

/** A test's delivery status, polled by the page until it is terminal. */
export const GET: RequestHandler = async ({ params, request, url }) =>
	notificationResponse(
		await readTestStatus(
			backendConfig(url.origin),
			request.headers.get('cookie'),
			params.notificationId
		)
	);
