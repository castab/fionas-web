import { backendConfig } from '$lib/server/config.js';
import { listDevices, readNotificationConfig } from '$lib/server/notifications.js';
import type { PageServerLoad } from './$types';

/**
 * Whether push is on (and its VAPID public key) plus the staff member's devices. The page's
 * own state (support, permission, this device) is only known in the browser.
 */
export const load: PageServerLoad = async ({ request, url, setHeaders }) => {
	setHeaders({ 'cache-control': 'no-store' });
	const config = backendConfig(url.origin);
	const cookie = request.headers.get('cookie');
	const settings = await readNotificationConfig(config, cookie);
	if (!settings.ok) return { push: { state: 'unavailable' as const } };
	if (!settings.data.enabled) return { push: { state: 'disabled' as const } };
	const devices = await listDevices(config, cookie);
	return {
		push: {
			state: 'enabled' as const,
			vapidPublicKey: settings.data.vapidPublicKey,
			devices: devices.ok ? devices.data : null
		}
	};
};
