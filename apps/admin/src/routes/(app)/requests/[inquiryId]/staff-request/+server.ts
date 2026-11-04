import { json } from '@sveltejs/kit';
import { applySetCookies } from '$lib/server/auth.js';
import { backendConfig } from '$lib/server/config.js';
import { getStaffRequest } from '$lib/server/staff-request.js';
import { isCommunicationSummary } from '$lib/conversation.js';
import { isCurrentStaffRequest } from '$lib/request-workspace.js';
import type { RequestHandler } from './$types';

/**
 * The authoritative staff-request projection, re-read after a live Activity update so Right now,
 * the Event card and the Serving plan show current financial and lifecycle state without
 * invalidating the workspace. Read-only: the same single `GET /staff/requests/{id}` and
 * validator as the page load. An incoherent projection is unavailable, never partial.
 */
export const GET: RequestHandler = async ({ locals, params, request, url, cookies }) => {
	const headers = { 'cache-control': 'no-store' };
	if (!locals.user) return json({ unavailable: true }, { status: 401, headers });
	const result = await getStaffRequest(
		backendConfig(url.origin),
		params.inquiryId,
		request.headers.get('cookie')
	);
	if (!result.ok)
		return json(
			{ unavailable: true },
			{
				status:
					result.error.status === 401 || result.error.status === 403 ? result.error.status : 503,
				headers
			}
		);
	applySetCookies(cookies, result.setCookies);
	const data = result.data;
	if (!isCurrentStaffRequest(data, params.inquiryId))
		return json({ unavailable: true }, { status: 503, headers });
	if (!isCommunicationSummary(data.communication)) delete data.communication;
	return json({ request: data }, { headers });
};
