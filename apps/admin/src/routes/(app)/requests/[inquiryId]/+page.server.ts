import { fail, redirect } from '@sveltejs/kit';
import { applySetCookies } from '$lib/server/auth.js';
import { backendConfig } from '$lib/server/config.js';
import { getStaffRequest, issueInquiryProposal } from '$lib/server/staff-request.js';
import {
	readDepositForm,
	depositInputError,
	matchesReviewedSuggestion,
	type DepositFormValues,
	type DepositErrorField
} from '$lib/deposit.js';
import type { DepositTermsRequest } from '$lib/request-contract.js';
import {
	isCurrentStaffRequest,
	isProposalEligible,
	hasProposalPermissions,
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

function quoteFailure(
	status: number,
	mutationAttempted = false,
	values?: DepositFormValues,
	depositErrorField?: DepositErrorField
) {
	const correctable = !!values && (status === 400 || status === 422);
	return fail(status >= 500 ? 503 : status, {
		quoteError:
			!mutationAttempted && status >= 500
				? 'We couldn’t review this request. Reload before trying to issue a quote.'
				: quoteErrorMessage(status),
		reviewRequired: !correctable,
		values,
		depositErrorField: correctable
			? (depositErrorField ??
				(values.depositChoice === 'percentage'
					? 'depositPercentage'
					: values.depositChoice === 'fixed'
						? 'depositAmount'
						: 'depositChoice'))
			: undefined
	});
}

export const actions: Actions = {
	issueProposal: async ({ params, locals, request, url, cookies }) => {
		if (!locals.user) redirect(303, '/login');
		if (!hasProposalPermissions(locals.user.permissions)) return quoteFailure(403);
		let form: FormData;
		try {
			form = await request.formData();
		} catch {
			return quoteFailure(422);
		}
		const values = readDepositForm(form);
		if (!values) return quoteFailure(422);
		const fieldError = depositInputError(values);
		if (fieldError) return quoteFailure(422, false, values, fieldError);
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
		if (!isProposalEligible(current.data)) return quoteFailure(409);
		if (
			values.depositChoice === 'suggested' &&
			!matchesReviewedSuggestion(values, current.data.suggestedDepositTerms)
		)
			return quoteFailure(409);
		const terms: DepositTermsRequest =
			values.depositChoice === 'suggested'
				? current.data.suggestedDepositTerms
				: values.depositChoice === 'percentage'
					? { type: 'PERCENTAGE', percentage: values.depositPercentage }
					: {
							type: 'FIXED',
							amount: values.depositAmount,
							currency: current.data.financial.currency
						};
		// Even if this read sees a newer Estimate, send only the version the staff member reviewed.
		const result = await issueInquiryProposal(
			config,
			params.inquiryId,
			Number(values.expectedVersion),
			terms,
			cookie
		);
		if (!result.ok) {
			if (result.error.status === 401) redirect(303, '/login');
			return quoteFailure(result.error.status, true, values);
		}
		applySetCookies(cookies, result.setCookies);
		// PRG removes the action query and prevents resubmission on refresh. The new state is confirmation.
		redirect(303, url.pathname);
	}
};
