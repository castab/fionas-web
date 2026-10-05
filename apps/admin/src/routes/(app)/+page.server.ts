import { dashboardView } from '$lib/dashboard.js';
import { applySetCookies } from '$lib/server/auth.js';
import { backendConfig } from '$lib/server/config.js';
import { getDashboard } from '$lib/server/dashboard.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, request, cookies, setHeaders }) => {
	setHeaders({ 'cache-control': 'no-store' });
	const result = await getDashboard(backendConfig(url.origin), request.headers.get('cookie'));
	if (!result.ok) {
		return {
			dashboard: null,
			dashboardError:
				result.error.status === 403 ? ('forbidden' as const) : ('unavailable' as const)
		};
	}
	applySetCookies(cookies, result.setCookies);
	return { dashboard: dashboardView(result.data), dashboardError: null };
};
