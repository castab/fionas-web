import { fail, redirect } from '@sveltejs/kit';
import { applySetCookies } from '$lib/server/auth.js';
import { backendConfig } from '$lib/server/config.js';
import { getStaffRequest, issueQuote } from '$lib/server/staff-request.js';
import {
	isCurrentStaffRequest,
	isQuoteEligible,
	QUOTE_PERMISSION,
	quoteErrorMessage,
	requestErrorKind
} from '$lib/request-workspace.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, request, url, cookies, setHeaders }) => {
	setHeaders({ 'cache-control': 'no-store' });
	const result = await getStaffRequest(
		backendConfig(url.origin),
		params.inquiryId,
		request.headers.get('cookie')
	);
	if (!result.ok) {
		if (result.error.status === 401) redirect(303, '/login');
		return {
			inquiryId: params.inquiryId,
			staffRequest: null,
			requestError: requestErrorKind(result.error.status)
		};
	}
	applySetCookies(cookies, result.setCookies);
	if (!isCurrentStaffRequest(result.data, params.inquiryId)) {
		return {
			inquiryId: params.inquiryId,
			staffRequest: null,
			requestError: 'unavailable' as const
		};
	}
	return { inquiryId: params.inquiryId, staffRequest: result.data, requestError: null };
};

function quoteFailure(status: number, mutationAttempted = false) {
	return fail(status >= 500 ? 503 : status, {
		quoteError:
			!mutationAttempted && status >= 500
				? 'We couldn’t review this request. Reload before trying to issue a quote.'
				: quoteErrorMessage(status),
		reviewRequired: true
	});
}

export const actions: Actions = {
	issueQuote: async ({ params, locals, request, url, cookies }) => {
		if (!locals.user) redirect(303, '/login');
		if (!locals.user.permissions.includes(QUOTE_PERMISSION)) return quoteFailure(403);
		const form = await request.formData();
		const version = form.get('expectedVersion');
		if (
			typeof version !== 'string' ||
			!/^[1-9]\d*$/.test(version) ||
			Number(version) > 2_147_483_647 ||
			form.getAll('expectedVersion').length !== 1 ||
			[...form.keys()].some((key) => key !== 'expectedVersion')
		) {
			return quoteFailure(422);
		}
		const config = backendConfig(url.origin);
		const cookie = request.headers.get('cookie');
		// Scope the mutation through the route's authoritative projection, never a posted document id.
		const current = await getStaffRequest(config, params.inquiryId, cookie);
		if (!current.ok) {
			if (current.error.status === 401) redirect(303, '/login');
			return quoteFailure(current.error.status);
		}
		applySetCookies(cookies, current.setCookies);
		if (!isCurrentStaffRequest(current.data, params.inquiryId)) return quoteFailure(503);
		if (!isQuoteEligible(current.data)) return quoteFailure(409);
		// Even if this read sees a newer Estimate, send only the version the staff member reviewed.
		const result = await issueQuote(config, current.data.financial.id, Number(version), cookie);
		if (!result.ok) {
			if (result.error.status === 401) redirect(303, '/login');
			return quoteFailure(result.error.status, true);
		}
		applySetCookies(cookies, result.setCookies);
		// PRG removes the action query and prevents resubmission on refresh. The new state is confirmation.
		redirect(303, url.pathname);
	}
};
