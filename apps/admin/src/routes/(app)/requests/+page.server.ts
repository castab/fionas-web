import { redirect } from '@sveltejs/kit';
import { applySetCookies } from '$lib/server/auth.js';
import { backendConfig } from '$lib/server/config.js';
import { getStaffRequests } from '$lib/server/request-list.js';
import {
	describeRejectedRequestList,
	isStaffRequestList,
	readListQuery,
	recoverySearch,
	requestListErrorKind,
	requestListView,
	type RequestListError
} from '$lib/request-list.js';
import type { PageServerLoad } from './$types';

/**
 * The Requests index: the URL's filter, search and cursor become exactly one `GET /staff/requests`
 * as the signed-in USER. The backend owns membership, search, order, counts and pagination.
 */
export const load: PageServerLoad = async ({ url, request, cookies, setHeaders }) => {
	setHeaders({ 'cache-control': 'no-store' });
	const { query, problem } = readListQuery(url.searchParams);
	const failure = (listError: RequestListError) => ({
		query,
		list: null,
		listError,
		recovery: listError === 'invalid' ? recoverySearch(query, problem) : null
	});
	// A URL the API would refuse is recovered here, without a backend read.
	if (problem) return failure('invalid');
	const result = await getStaffRequests(
		backendConfig(url.origin),
		query,
		request.headers.get('cookie')
	);
	if (!result.ok) {
		if (result.error.status === 401) redirect(303, '/login');
		// Operator hint only: status and code, no query text or customer data.
		console.error(`[requests] backend ${result.error.status} ${result.error.code}`);
		return failure(requestListErrorKind(result.error.status));
	}
	applySetCookies(cookies, result.setCookies);
	if (!isStaffRequestList(result.data)) {
		console.error(
			`[requests] refused by the collection validator: ${JSON.stringify(describeRejectedRequestList(result.data))}`
		);
		return failure('unavailable');
	}
	return { query, list: requestListView(result.data), listError: null, recovery: null };
};
