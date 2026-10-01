import { env } from '$env/dynamic/private';
import type { BackendConfig } from './backend.js';

/**
 * Backend config, read per request. `ADMIN_ORIGIN` is the admin site's public origin and must be in
 * the API's trusted-origin list; without it the request's own origin is used, which is only right
 * when nothing rewrites the host in front of the server.
 */
export function backendConfig(requestOrigin: string): BackendConfig {
	return {
		baseUrl: (env.COMMERCE_API_URL ?? 'http://localhost:8080').replace(/\/+$/, ''),
		origin: env.ADMIN_ORIGIN?.trim().replace(/\/+$/, '') || requestOrigin
	};
}
