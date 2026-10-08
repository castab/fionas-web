import { fail, redirect, type ActionFailure } from '@sveltejs/kit';
import type { ApiError } from '@fionas/shared';
import { applySetCookies } from '$lib/server/auth.js';
import { backendConfig } from '$lib/server/config.js';
import type { BackendConfig } from '$lib/server/backend.js';
import {
	getStaffRequest,
	getInquiryForm,
	getOfferingCatalog,
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
import type { CurrentStaffRequest, DepositTermsRequest } from '$lib/request-contract.js';
import type { InquiryQuotePreviewResponse, QuotePricingBasis } from '$lib/quote-contract.js';
import {
	basisStillReviewed,
	buildComposition,
	builderChoices,
	chooseBasis,
	effectiveConfiguration,
	isQuotePreview,
	quoteInputErrors,
	quoteViolationFeedback,
	readQuoteForm,
	type BuilderChoices,
	type FeedbackSection,
	type QuoteFieldErrors,
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
	if (!result.ok) {
		if (result.error.status === 401) redirect(303, '/login');
		return {
			inquiryId: params.inquiryId,
			staffRequest: null,
			requestError: requestErrorKind(result.error.status),
			quoteOpen,
			builderChoices: null
		};
	}
	applySetCookies(cookies, result.setCookies);
	if (!isCurrentStaffRequest(result.data, params.inquiryId)) {
		return {
			inquiryId: params.inquiryId,
			staffRequest: null,
			requestError: 'unavailable' as const,
			quoteOpen,
			builderChoices: null
		};
	}
	let choices: BuilderChoices | null = null;
	// Selection choices are read only while the builder is open and the service may be edited.
	if (
		quoteOpen &&
		canIssueQuote(result.data, locals.user?.permissions ?? []) &&
		effectiveConfiguration(result.data)
	) {
		const [catalog, form] = await Promise.all([
			getOfferingCatalog(config, cookie),
			getInquiryForm(config, cookie)
		]);
		if (catalog.ok) applySetCookies(cookies, catalog.setCookies);
		if (form.ok) applySetCookies(cookies, form.setCookies);
		choices = catalog.ok && form.ok ? builderChoices(catalog.data, form.data) : null;
	}
	return {
		inquiryId: params.inquiryId,
		staffRequest: result.data,
		requestError: null,
		quoteOpen,
		builderChoices: choices
	};
};

type QuoteNotices = { repriced?: boolean; overridesCleared?: boolean; reviewStale?: boolean };
type QuoteFailureData = {
	quoteError: string;
	reviewRequired: boolean;
	quoteValues?: QuoteFormValues;
	fieldErrors?: QuoteFieldErrors;
	feedback?: Partial<Record<FeedbackSection, string[]>>;
	catalogStale?: boolean;
	notices?: QuoteNotices;
};

function quoteFailure(status: number, mutationAttempted = false, quoteValues?: QuoteFormValues) {
	return fail(status >= 500 ? 503 : status, {
		quoteError:
			!mutationAttempted && status >= 500
				? 'We couldn’t review this request. Reload before trying to issue a quote.'
				: quoteErrorMessage(status),
		reviewRequired: true,
		quoteValues
	} satisfies QuoteFailureData);
}

/** A definite refusal: nothing was written, so staff may correct the quote and preview again. */
function correctableFailure(error: ApiError, quoteValues: QuoteFormValues, notices?: QuoteNotices) {
	if (error.status === 409 && error.code === 'CATALOG_REVISION_STALE')
		return fail(409, {
			quoteError:
				'The menu changed since this page loaded. Review the picks against the refreshed menu, then preview again.',
			reviewRequired: false,
			catalogStale: true,
			quoteValues,
			notices
		} satisfies QuoteFailureData);
	return fail(422, {
		quoteError: 'Some of this quote couldn’t be accepted. Review the notes below.',
		reviewRequired: false,
		feedback: quoteViolationFeedback(error.violations),
		quoteValues,
		notices
	} satisfies QuoteFailureData);
}

type QuoteContext = {
	config: BackendConfig;
	cookie: string | null;
	inquiryId: string;
	data: CurrentStaffRequest;
	values: QuoteFormValues;
	terms: DepositTermsRequest;
	setCookies: (values: string[]) => void;
};

/** Shared by preview and issue: permission, strict envelope, one coherent read, local checks. */
async function quoteContext({
	params,
	locals,
	request,
	url,
	cookies
}: RequestEvent): Promise<
	{ context: QuoteContext } | { failure: ActionFailure<QuoteFailureData> }
> {
	if (!locals.user) redirect(303, '/login');
	if (!hasProposalPermissions(locals.user.permissions)) return { failure: quoteFailure(403) };
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return { failure: quoteFailure(422) };
	}
	const values = readQuoteForm(form);
	if (!values) return { failure: quoteFailure(422) };
	const config = backendConfig(url.origin);
	const cookie = request.headers.get('cookie');
	// Scope every call through the route's authoritative projection, never a posted document id.
	const current = await getStaffRequest(config, params.inquiryId, cookie);
	if (!current.ok) {
		if (current.error.status === 401) redirect(303, '/login');
		return { failure: quoteFailure(current.error.status, false, values) };
	}
	applySetCookies(cookies, current.setCookies);
	const data = current.data;
	if (!isCurrentStaffRequest(data, params.inquiryId))
		return { failure: quoteFailure(503, false, values) };
	if (
		!isProposalEligible(data) ||
		(values.service && !effectiveConfiguration(data)) ||
		(values.deposit.depositChoice === 'suggested' &&
			!matchesReviewedSuggestion(values.deposit, data.suggestedDepositTerms))
	)
		return { failure: quoteFailure(409, false, values) };
	const fieldErrors = quoteInputErrors(values, data.financial.currency);
	if (Object.keys(fieldErrors).length)
		return {
			failure: fail(422, {
				quoteError: 'Check the highlighted fields, then preview again.',
				reviewRequired: false,
				fieldErrors,
				quoteValues: values
			} satisfies QuoteFailureData)
		};
	const deposit = values.deposit;
	const terms: DepositTermsRequest =
		deposit.depositChoice === 'suggested'
			? data.suggestedDepositTerms
			: deposit.depositChoice === 'percentage'
				? { type: 'PERCENTAGE', percentage: deposit.depositPercentage }
				: { type: 'FIXED', amount: deposit.depositAmount, currency: data.financial.currency };
	return {
		context: {
			config,
			cookie,
			inquiryId: params.inquiryId,
			data,
			values,
			terms,
			setCookies: (setCookies) => applySetCookies(cookies, setCookies)
		}
	};
}

/**
 * Preview the posted intent. A REVISE whose picks turn out to change pricing is previewed once more
 * as a full reprice; previews write nothing, so the second query is safe and staff see the switch.
 */
async function preview(
	context: QuoteContext,
	basis: QuotePricingBasis,
	notices: QuoteNotices = {}
) {
	const { config, cookie, inquiryId, data, values, terms } = context;
	const currency = data.financial.currency;
	// Even if the read sees a newer Estimate, preview only the version the staff member reviewed.
	const expectedDocumentVersion = Number(values.deposit.expectedVersion);
	let built = buildComposition(values, basis, currency);
	let result = await previewInquiryQuote(
		config,
		inquiryId,
		{ expectedDocumentVersion, composition: built.composition, terms },
		cookie
	);
	if (
		!result.ok &&
		basis === 'REVISE_SERVICE_SELECTIONS' &&
		result.error.status === 422 &&
		result.error.violations.includes('SERVICE_SELECTIONS_CHANGE_PRICING')
	) {
		basis = 'REPRICE_CONFIGURATION';
		notices = { ...notices, repriced: true };
		built = buildComposition(values, basis, currency);
		result = await previewInquiryQuote(
			config,
			inquiryId,
			{ expectedDocumentVersion, composition: built.composition, terms },
			cookie
		);
	}
	if (built.clearedOverrides) notices = { ...notices, overridesCleared: true };
	if (!result.ok) {
		const error = result.error;
		if (error.status === 401) redirect(303, '/login');
		if (
			error.status === 400 ||
			error.status === 422 ||
			(error.status === 409 && error.code === 'CATALOG_REVISION_STALE')
		)
			return correctableFailure(error, values, notices);
		if (error.status >= 500)
			return fail(503, {
				quoteError: 'We couldn’t preview this quote just now. Nothing was issued — try again.',
				reviewRequired: false,
				quoteValues: values,
				notices
			} satisfies QuoteFailureData);
		return quoteFailure(error.status, false, values);
	}
	context.setCookies(result.setCookies);
	if (!isQuotePreview(result.data, data) || result.data.pricingBasis !== basis)
		return quoteFailure(503, false, values);
	const reviewed: InquiryQuotePreviewResponse = result.data;
	return {
		preview: reviewed,
		notices,
		quoteValues: {
			...values,
			reviewToken: reviewed.reviewToken,
			reviewedBasis: basis,
			reviewedFingerprint: reviewFingerprint(expectedDocumentVersion, built.composition, terms)
		}
	};
}

export const actions: Actions = {
	markServed: fulfillmentAction('markServed'),
	closeInquiry: fulfillmentAction('closeInquiry'),
	recordDeposit: paymentAction(true),
	recordInvoicePayment: paymentAction(false),
	previewQuote: async (event) => {
		const result = await quoteContext(event);
		if ('failure' in result) return result.failure;
		const { values, data } = result.context;
		return preview(result.context, chooseBasis(values.service, effectiveConfiguration(data)));
	},
	issueQuote: async (event) => {
		const result = await quoteContext(event);
		if ('failure' in result) return result.failure;
		const context = result.context;
		const { values, data, terms } = context;
		const basis = chooseBasis(values.service, effectiveConfiguration(data));
		const expectedDocumentVersion = Number(values.deposit.expectedVersion);
		// Only the exact previewed command may be issued; anything else is previewed again for review.
		if (
			!values.reviewToken ||
			!values.reviewedBasis ||
			!basisStillReviewed(values.reviewedBasis, basis)
		)
			return preview(context, basis, { reviewStale: true });
		const { composition } = buildComposition(values, values.reviewedBasis, data.financial.currency);
		if (
			reviewFingerprint(expectedDocumentVersion, composition, terms) !== values.reviewedFingerprint
		)
			return preview(context, basis, { reviewStale: true });
		const issued = await issueInquiryProposal(
			context.config,
			context.inquiryId,
			expectedDocumentVersion,
			terms,
			context.cookie,
			{ composition, reviewToken: values.reviewToken }
		);
		if (!issued.ok) {
			const error = issued.error;
			if (error.status === 401) redirect(303, '/login');
			// Definite refusals: nothing was issued. Show the new result and require a new approval.
			if (error.status === 409 && error.code === 'QUOTE_REVIEW_STALE')
				return preview(context, basis, { reviewStale: true });
			if (error.status === 422 || (error.status === 409 && error.code === 'CATALOG_REVISION_STALE'))
				return correctableFailure(error, values);
			// Exactly one attempt. A 5xx or timeout may follow commit; only a clean GET confirms.
			return quoteFailure(error.status, true, values);
		}
		context.setCookies(issued.setCookies);
		// PRG removes the action query and prevents resubmission on refresh. The new state is confirmation.
		redirect(303, event.url.pathname);
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
