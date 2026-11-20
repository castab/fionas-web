import { backendConfig } from '$lib/server/config.js';
import {
	enrollDevice,
	listDevices,
	notificationError,
	notificationResponse,
	parseEnrollment,
	readBody
} from '$lib/server/notifications.js';
import type { RequestHandler } from './$types';

/** The signed-in staff member's devices (never endpoints or keys), as `{ devices }`. */
export const GET: RequestHandler = async ({ request, url }) => {
	const result = await listDevices(backendConfig(url.origin), request.headers.get('cookie'));
	return notificationResponse(result.ok ? { ...result, data: { devices: result.data } } : result);
};

/**
 * Enrolls (or re-enrolls) this browser's push subscription. Called by the Notifications page, the
 * signed-in shell on load and the service worker's `pushsubscriptionchange`. Only the whitelisted
 * subscription fields and a normalized label are forwarded.
 */
export const POST: RequestHandler = async ({ request, url }) => {
	const enrollment = parseEnrollment(await readBody(request));
	if (!enrollment) return notificationResponse(notificationError(422, 'validation_failed'));
	return notificationResponse(
		await enrollDevice(backendConfig(url.origin), request.headers.get('cookie'), enrollment)
	);
};
