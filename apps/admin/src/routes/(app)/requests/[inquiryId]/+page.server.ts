import { fail, redirect } from '@sveltejs/kit';
import { applySetCookies } from '$lib/server/auth.js';
import { backendConfig } from '$lib/server/config.js';
import {
	getStaffRequest,
	issueInquiryProposal,
	previewInquiryQuote,
	recordPayment,
	markInquiryServed,
	closeInquiry
} from '$lib/server/staff-request.js';
import { reviewFingerprint } from '$lib/server/quote-review.js';
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
import { matchesReviewedSuggestion } from '$lib/deposit.js';
import { CURRENCY } from '$lib/currency.js';
import {
	initialQuoteValues,
	buildCommand,
	isQuotePreview,
	quoteInputErrors,
	readQuoteForm,
	reviewedTerms,
	type QuoteActionResult,
	type QuoteFormValues
} from '$lib/quote-builder.js';
import {
	canMarkServed,
	canCloseInquiry,
	canIssueQuote,
	hasFulfillmentPermission,
	fulfillmentErrorMessage,
	type FulfillmentAction,
	isCurrentStaffRequest,
	isProposalEligible,
	hasProposalPermissions,
	quoteErrorMessage,
	requestErrorKind
} from '$lib/request-workspace.js';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

export const load: PageServerLoad = async ({
	params,
	request,
	url,
	cookies,
	setHeaders,
	locals
}) => {
	setHeaders({ 'cache-control': 'no-store' });
	const config = backendConfig(url.origin);
	const cookie = request.headers.get('cookie');
	const quoteOpen = url.searchParams.has('quote');
	const result = await getStaffRequest(config, params.inquiryId, cookie);
	if (!result.ok && result.error.status === 401) redirect(303, '/login');
	if (!result.ok || !isCurrentStaffRequest(result.data, params.inquiryId))
		return {
			inquiryId: params.inquiryId,
			staffRequest: null,
			requestError: result.ok ? ('unavailable' as const) : requestErrorKind(result.error.status),
			quoteOpen,
			initialQuote: null
		};
	applySetCookies(cookies, result.setCookies);
	const data = result.data;
	let initialQuote: QuoteActionResult | null = null;
	if (
		quoteOpen &&
		canIssueQuote(data, locals.user?.permissions ?? []) &&
		request.method === 'GET'
	) {
		const values = initialQuoteValues(data);
		const command = buildCommand(values);
		const terms = data.suggestedDepositTerms;
		const opening = await previewInquiryQuote(
			config,
			params.inquiryId,
			{ expectedDocumentVersion: data.financial.version, ...command, terms },
			cookie
		);
		if (
			opening.ok &&
			isQuotePreview(opening.data, {
				inquiryId: params.inquiryId,
				documentId: data.financial.id
			})
		) {
			applySetCookies(cookies, opening.setCookies);
			initialQuote = {
				preview: opening.data,
				quoteValues: {
					...values,
					reviewToken: opening.data.reviewToken,
					reviewedFingerprint: reviewFingerprint(data.financial.version, command, terms)
				}
			};
		}
	}
	return {
		inquiryId: params.inquiryId,
		staffRequest: data,
		requestError: null,
		quoteOpen,
		initialQuote
	};
};
function quoteFailure(status: number, values?: QuoteFormValues, attempted = false) {
	return fail(status >= 500 ? 503 : status, {
		quoteError: attempted
			? quoteErrorMessage(status)
			: status >= 500
				? 'We couldn’t preview this quote. Nothing was issued. Try again.'
				: quoteErrorMessage(status),
		reviewRequired:
			(attempted && status !== 400 && status !== 422) || status === 403 || status === 409,
		quoteValues: values
	} satisfies QuoteActionResult);
}
async function quoteAction(event: RequestEvent, issue: boolean) {
	const { locals, request, url, params, cookies } = event;
	if (!locals.user) redirect(303, '/login');
	if (!hasProposalPermissions(locals.user.permissions)) return quoteFailure(403);
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return quoteFailure(422);
	}
	const parsed = readQuoteForm(form);
	if (!parsed) return quoteFailure(422);
	const values = parsed;
	const config = backendConfig(url.origin);
	const cookie = request.headers.get('cookie');
	const errors = quoteInputErrors(values);
	if (Object.keys(errors).length && !issue)
		return fail(422, {
			quoteError: 'Check the highlighted fields.',
			quoteValues: values,
			fieldErrors: errors,
			reviewRequired: false
		});
	const version = Number(values.deposit.expectedVersion);
	const command = buildCommand(values);
	const terms = reviewedTerms(values.deposit);
	const fingerprint = reviewFingerprint(version, command, terms);
	async function preview(stale = false) {
		const result = await previewInquiryQuote(
			config,
			params.inquiryId,
			{ expectedDocumentVersion: version, ...command, terms },
			cookie
		);
		if (!result.ok) {
			if (result.error.status === 401) redirect(303, '/login');
			return quoteFailure(result.error.status, values);
		}
		applySetCookies(cookies, result.setCookies);
		if (
			!isQuotePreview(result.data, { inquiryId: params.inquiryId }) ||
			result.data.reviewedDocumentVersion !== version
		)
			return quoteFailure(503, values);
		return {
			preview: result.data,
			quoteValues: {
				...values,
				reviewToken: result.data.reviewToken,
				reviewedFingerprint: fingerprint
			},
			notices: { reviewStale: stale },
			reviewRequired: false
		};
	}
	if (!issue) return preview();
	const current = await getStaffRequest(config, params.inquiryId, cookie);
	if (!current.ok) {
		if (current.error.status === 401) redirect(303, '/login');
		return quoteFailure(current.error.status, values);
	}
	applySetCookies(cookies, current.setCookies);
	if (!isCurrentStaffRequest(current.data, params.inquiryId))
		return quoteFailure(503, values, true);
	if (
		!isProposalEligible(current.data) ||
		current.data.financial.version !== version ||
		current.data.financial.currency !== CURRENCY ||
		(values.deposit.depositChoice === 'suggested' &&
			!matchesReviewedSuggestion(values.deposit, current.data.suggestedDepositTerms))
	)
		return quoteFailure(409, values, true);
	if (Object.keys(errors).length)
		return fail(422, {
			quoteError: 'Check the highlighted fields.',
			quoteValues: values,
			fieldErrors: errors,
			reviewRequired: false
		});
	if (!values.reviewToken || fingerprint !== values.reviewedFingerprint) return preview(true);
	const result = await issueInquiryProposal(config, params.inquiryId, version, terms, cookie, {
		...command,
		reviewToken: values.reviewToken
	});
	if (!result.ok) {
		if (result.error.status === 401) redirect(303, '/login');
		if (result.error.code === 'QUOTE_REVIEW_STALE') return preview(true);
		return quoteFailure(result.error.status, values, true);
	}
	applySetCookies(cookies, result.setCookies);
	redirect(303, url.pathname);
}
export const actions: Actions = {
	markServed: fulfillmentAction('markServed'),
	closeInquiry: fulfillmentAction('closeInquiry'),
	recordDeposit: paymentAction(true),
	recordInvoicePayment: paymentAction(false),
	previewQuote: (event) => quoteAction(event, false),
	issueQuote: (event) => quoteAction(event, true)
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
