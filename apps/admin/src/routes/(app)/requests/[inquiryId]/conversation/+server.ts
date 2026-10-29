import { json } from '@sveltejs/kit';
import { getStaffTimeline } from '$lib/server/conversation.js';
import { backendConfig } from '$lib/server/config.js';
import { applySetCookies } from '$lib/server/auth.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params, request, url, cookies }) => {
	const headers = { 'cache-control': 'no-store' };
	if (!locals.user) return json({ unavailable: true }, { status: 401, headers });
	const result = await getStaffTimeline(
		backendConfig(url.origin),
		params.inquiryId,
		request.headers.get('cookie')
	);
	if (!result.ok)
		return json(
			{ unavailable: true },
			{ status: result.error.status === 403 ? 403 : 503, headers }
		);
	applySetCookies(cookies, result.setCookies);
	return json(result.data, { headers });
};
