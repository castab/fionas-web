import type { StaffDashboardResponse } from '../dashboard-contract.js';
import { request, type ApiResult, type BackendConfig } from './backend.js';

/** One projection read as the signed-in USER. No per-inquiry enrichment or SERVICE auth. */
export function getDashboard(
	config: BackendConfig,
	cookie: string | null
): Promise<ApiResult<StaffDashboardResponse>> {
	return request<StaffDashboardResponse>(config, '/staff/dashboard', { method: 'GET', cookie });
}
