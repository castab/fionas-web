import { backendConfig } from '$lib/server/config.js';
import {
	notificationError,
	notificationResponse,
	readBody,
	sendTestNotification
} from '$lib/server/notifications.js';
import type { RequestHandler } from './$types';

/**
 * Queues a test push to one device. The browser owns the key: one per click, reused for that
 * click's retries, so a lost answer never sends a second test.
 */
export const POST: RequestHandler = async ({ request, url }) => {
	const body = await readBody(request);
	const subscriptionId =
		typeof body === 'object' && body !== null && 'subscriptionId' in body
			? body.subscriptionId
			: null;
	const key =
		typeof body === 'object' && body !== null && 'idempotencyKey' in body
			? body.idempotencyKey
			: null;
	if (typeof subscriptionId !== 'string' || typeof key !== 'string')
		return notificationResponse(notificationError(422, 'validation_failed'));
	return notificationResponse(
		await sendTestNotification(
			backendConfig(url.origin),
			request.headers.get('cookie'),
			subscriptionId,
			key
		)
	);
};
