import type { StaffRequestListResponse } from '../request-list-contract.js';
import type { RequestListQuery } from '../request-list.js';
import { request, type ApiResult, type BackendConfig } from './backend.js';

/**
 * One collection page as the signed-in USER: no per-inquiry enrichment, no SERVICE auth, no retry.
 * Each parameter is sent at most once (the API refuses repeats); `all` is sent explicitly, a blank
 * search and the first page's cursor are omitted, and the page size is left to the backend.
 */
export function getStaffRequests(
	config: BackendConfig,
	query: RequestListQuery,
	cookie: string | null
): Promise<ApiResult<StaffRequestListResponse>> {
	const params = [`filter=${encodeURIComponent(query.filter)}`];
	if (query.q) params.push(`q=${encodeURIComponent(query.q)}`);
	if (query.cursor) params.push(`cursor=${encodeURIComponent(query.cursor)}`);
	return request<StaffRequestListResponse>(config, `/staff/requests?${params.join('&')}`, {
		method: 'GET',
		cookie
	});
}
