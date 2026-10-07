import { fail, redirect } from '@sveltejs/kit';
import { applySetCookies } from '$lib/server/auth.js';
import { backendConfig } from '$lib/server/config.js';
import {
	getStaffRequest,
	issueInquiryProposal,
	recordPayment,
	markInquiryServed,
	closeInquiry
} from '$lib/server/staff-request.js';
import {
	canRecordDeposit,
	canRecordInvoicePayment,
	hasPaymentPermission,
	readPaymentForm,
	invoiceAmountValid,
	paymentErrorMessage
} from '$lib/payments.js';
import type { PaymentFormValues } from '$lib/payments.js';
import type { RecordPaymentRequest } from '$lib/payment-contract.js';
import {
	readDepositForm,
	depositInputError,
	matchesReviewedSuggestion,
	type DepositFormValues,
	type DepositErrorField
} from '$lib/deposit.js';
import type { DepositTermsRequest } from '$lib/request-contract.js';
import {
	canMarkServed,
	canCloseInquiry,
	hasFulfillmentPermission,
	fulfillmentErrorMessage,
	type FulfillmentAction,
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
	markServed: fulfillmentAction('markServed'),
	closeInquiry: fulfillmentAction('closeInquiry'),
	recordDeposit: paymentAction(true),
	recordInvoicePayment: paymentAction(false),
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

function fulfillmentAction(action: FulfillmentAction): Actions[string] {
	return async ({ params, locals, request, url, cookies }) => {
		if (!locals.user) redirect(303, '/login');
		const failure = (status: number, attempted = false) =>
			fail(status >= 500 ? 503 : status, {
				fulfillmentError: fulfillmentErrorMessage(status, action, attempted),
				fulfillmentReviewRequired: true
			});
		if (!hasFulfillmentPermission(locals.user.permissions)) return failure(403);
		try {
			if ([...(await request.formData()).keys()].length !== 0) return failure(422);
		} catch {
			return failure(422);
		}
		const config = backendConfig(url.origin);
		const cookie = request.headers.get('cookie');
		const current = await getStaffRequest(config, params.inquiryId, cookie);
		if (!current.ok) {
			if (current.error.status === 401) redirect(303, '/login');
			return failure(current.error.status);
		}
		applySetCookies(cookies, current.setCookies);
		if (!isCurrentStaffRequest(current.data, params.inquiryId)) return failure(503);
		const eligible = action === 'markServed' ? canMarkServed : canCloseInquiry;
		if (!eligible(current.data, locals.user.permissions)) return failure(409);
		// One bodyless attempt. An unavailable response may follow commit; reload is confirmation.
		const mutate = action === 'markServed' ? markInquiryServed : closeInquiry;
		const result = await mutate(config, params.inquiryId, cookie);
		if (!result.ok) {
			if (result.error.status === 401) redirect(303, '/login');
			return failure(result.error.status, true);
		}
		applySetCookies(cookies, result.setCookies);
		redirect(303, url.pathname);
	};
}

function paymentFailure(
	status: number,
	mutationAttempted = false,
	paymentValues?: PaymentFormValues,
	correctable = false
) {
	return fail(status >= 500 ? 503 : status, {
		paymentError: paymentErrorMessage(status, mutationAttempted),
		paymentReviewRequired: !correctable,
		paymentValues
	});
}

function paymentAction(deposit: boolean): Actions[string] {
	return async ({ params, locals, request, url, cookies }) => {
		if (!locals.user) redirect(303, '/login');
		if (!hasPaymentPermission(locals.user.permissions)) return paymentFailure(403);
		let form: FormData;
		try {
			form = await request.formData();
		} catch {
			return paymentFailure(422);
		}
		const values = readPaymentForm(form, deposit);
		if (!values) return paymentFailure(422);
		const config = backendConfig(url.origin);
		const cookie = request.headers.get('cookie');
		const current = await getStaffRequest(config, params.inquiryId, cookie);
		if (!current.ok) {
			if (current.error.status === 401) redirect(303, '/login');
			return paymentFailure(current.error.status);
		}
		applySetCookies(cookies, current.setCookies);
		if (!isCurrentStaffRequest(current.data, params.inquiryId)) return paymentFailure(503);
		const data = current.data;
		if (
			values.expectedVersion !== String(data.financial.version) ||
			(deposit
				? !canRecordDeposit(data, locals.user.permissions) ||
					values.expectedProposalId !== data.proposal?.id
				: !canRecordInvoicePayment(data, locals.user.permissions))
		)
			return paymentFailure(409);
		if (
			!deposit &&
			!invoiceAmountValid(
				values.amount!,
				data.financial.reconciliation.balance,
				data.financial.currency
			)
		)
			return paymentFailure(422, false, values, true);
		const json: RecordPaymentRequest = {
			documentVersion: Number(values.expectedVersion),
			method: values.method,
			amount:
				deposit && data.depositRequirement.state === 'ACTIVE'
					? data.depositRequirement.requiredAmount.amount
					: values.amount!
		};
		if (deposit) json.expectedProposalId = values.expectedProposalId;
		// Exactly one attempt. Even a 500 can follow commit; only a clean GET confirms the result.
		const result = await recordPayment(config, data.financial.id, json, cookie);
		if (!result.ok) {
			if (result.error.status === 401) redirect(303, '/login');
			return paymentFailure(result.error.status, true);
		}
		applySetCookies(cookies, result.setCookies);
		redirect(303, url.pathname);
	};
}
