import { json } from '@sveltejs/kit';
import { backendConfig } from '$lib/server/config.js';
import { loadCustomerPayments } from '$lib/server/customer-payments.js';
import type { RequestHandler } from './$types';

/**
 * Refreshes the Customer payments section after a timeline notification: link status (never the
 * URL) and attempt diagnostics, with the staff member's own session. Read-only.
 */
export const GET: RequestHandler = async ({ locals, params, request, url }) => {
	const headers = { 'cache-control': 'no-store' };
	if (!locals.user) return json({ availability: 'forbidden' }, { status: 401, headers });
	const view = await loadCustomerPayments(
		backendConfig(url.origin),
		params.inquiryId,
		request.headers.get('cookie'),
		null,
		locals.user.permissions
	);
	return json(view ?? { availability: 'forbidden' }, { status: view ? 200 : 403, headers });
};
