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
import { matchesReviewedSuggestion, suggestionValue } from '$lib/deposit.js';
import type {
	CurrentStaffRequest,
	DepositTermsRequest,
	InquiryRequestedPricing
} from '$lib/request-contract.js';
import type { QuotePricingBasis } from '$lib/quote-contract.js';
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
	reviewedTerms,
	type BuilderChoices,
	type FeedbackSection,
	type QuoteActionResult,
	type QuoteFieldErrors,
	type QuoteFormValues,
	type QuoteNotices
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
			builderChoices: null,
			initialQuote: null
		};
	}
	applySetCookies(cookies, result.setCookies);
	if (!isCurrentStaffRequest(result.data, params.inquiryId)) {
		return {
			inquiryId: params.inquiryId,
			staffRequest: null,
			requestError: 'unavailable' as const,
			quoteOpen,
			builderChoices: null,
			initialQuote: null
		};
	}
	const data = result.data;
	let choices: BuilderChoices | null = null;
	let initialQuote: QuoteActionResult | null = null;
	// The builder opens complete: its choices and the unchanged Estimate's preview are read together.
	if (quoteOpen && canIssueQuote(data, locals.user?.permissions ?? [])) {
		const effective = effectiveConfiguration(data);
		const [catalog, form, opening] = await Promise.all([
			effective ? getOfferingCatalog(config, cookie) : null,
			effective ? getInquiryForm(config, cookie) : null,
			// After a form action the page shows that action's own result; only a GET opens fresh.
			request.method === 'GET' ? openingPreview(config, cookie, data, effective) : null
		]);
		if (catalog?.ok) applySetCookies(cookies, catalog.setCookies);
		if (form?.ok) applySetCookies(cookies, form.setCookies);
		choices = catalog?.ok && form?.ok ? builderChoices(catalog.data, form.data) : null;
		if (opening) {
			applySetCookies(cookies, opening.setCookies);
			initialQuote = opening.result;
		}
	}
	return {
		inquiryId: params.inquiryId,
		staffRequest: data,
		requestError: null,
		quoteOpen,
		builderChoices: choices,
		initialQuote
	};
};

/**
 * The preview of the Estimate as it stands, with the suggested deposit: exactly what the builder's
 * untouched form would post. Any failure just leaves the builder to preview once it has mounted.
 */
async function openingPreview(
	config: BackendConfig,
	cookie: string | null,
	data: CurrentStaffRequest,
	effective: InquiryRequestedPricing | null
): Promise<{ result: QuoteActionResult; setCookies: string[] } | null> {
	const terms = data.suggestedDepositTerms;
	const expectedDocumentVersion = data.financial.version;
	const composition = { pricing: { mode: 'KEEP_ESTIMATE' as const } };
	const result = await previewInquiryQuote(
		config,
		data.inquiry.id,
		{ expectedDocumentVersion, composition, terms },
		cookie
	);
	if (
		!result.ok ||
		!isQuotePreview(result.data, {
			inquiryId: data.inquiry.id,
			currency: data.financial.currency,
			documentId: data.financial.id
		}) ||
		result.data.pricingBasis !== 'KEEP_ESTIMATE'
	)
		return null;
	return {
		setCookies: result.setCookies,
		result: {
			preview: result.data,
			notices: {},
			quoteValues: {
				deposit: {
					expectedVersion: String(expectedDocumentVersion),
					depositChoice: 'suggested',
					reviewedSuggestionType: terms.type,
					reviewedSuggestionValue: suggestionValue(terms),
					depositPercentage: '',
					depositAmount: ''
				},
				service: null,
				overrides: [],
				adjustments: [],
				reviewToken: result.data.reviewToken,
				reviewedBasis: 'KEEP_ESTIMATE',
				reviewedFingerprint: reviewFingerprint(expectedDocumentVersion, composition, terms),
				reviewedCurrency: data.financial.currency,
				reviewedConfiguration: effective
			}
		}
	};
}

type QuoteFailureData = {
	quoteError: string;
	reviewRequired: boolean;
	quoteValues?: QuoteFormValues;
	fieldErrors?: QuoteFieldErrors;
	feedback?: Partial<Record<FeedbackSection, string[]>>;
	catalogStale?: boolean;
	notices?: QuoteNotices;
};
type Failure = { failure: ActionFailure<QuoteFailureData> };

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

function fieldFailure(values: QuoteFormValues, currency: string): Failure | null {
	const fieldErrors = quoteInputErrors(values, currency);
	return Object.keys(fieldErrors).length
		? {
				failure: fail(422, {
					quoteError: 'Check the highlighted fields, then preview again.',
					reviewRequired: false,
					fieldErrors,
					quoteValues: values
				} satisfies QuoteFailureData)
			}
		: null;
}

type QuoteContext = {
	config: BackendConfig;
	cookie: string | null;
	inquiryId: string;
	values: QuoteFormValues;
	terms: DepositTermsRequest;
	currency: string;
	/** What the reviewed Estimate was priced from, for choosing the pricing mode. */
	effective: InquiryRequestedPricing | null;
	/** Known only from an authoritative read; a preview checks it when present. */
	documentId?: string;
	setCookies: (values: string[]) => void;
};
type Envelope = { values: QuoteFormValues; config: BackendConfig; cookie: string | null };

/** Permission and the strict form envelope, before any backend access. */
async function readEnvelope({
	locals,
	request,
	url
}: RequestEvent): Promise<{ envelope: Envelope } | Failure> {
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
	return {
		envelope: {
			values,
			config: backendConfig(url.origin),
			cookie: request.headers.get('cookie')
		}
	};
}

/**
 * A preview writes nothing, so it trusts the reviewed snapshot the page posted (currency, priced
 * configuration, deposit suggestion) instead of re-reading the request. Commerce validates every
 * value; issuing re-reads everything and only accepts exactly what was previewed.
 */
function postedContext(
	{ params, cookies }: RequestEvent,
	{ values, config, cookie }: Envelope
): { context: QuoteContext } | Failure {
	const currency = values.reviewedCurrency;
	if (!currency || (values.service && !values.reviewedConfiguration))
		return { failure: quoteFailure(422, false, values) };
	const invalid = fieldFailure(values, currency);
	if (invalid) return invalid;
	return {
		context: {
			config,
			cookie,
			inquiryId: params.inquiryId,
			values,
			terms: reviewedTerms(values.deposit, currency),
			currency,
			effective: values.reviewedConfiguration,
			setCookies: (setCookies) => applySetCookies(cookies, setCookies)
		}
	};
}

/** Issuing scopes everything through one coherent, authoritative read of this route's request. */
async function authoritativeContext(
	{ params, cookies }: RequestEvent,
	{ values, config, cookie }: Envelope
): Promise<{ context: QuoteContext } | Failure> {
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
	const effective = effectiveConfiguration(data);
	if (
		!isProposalEligible(data) ||
		(values.service && !effective) ||
		(values.deposit.depositChoice === 'suggested' &&
			!matchesReviewedSuggestion(values.deposit, data.suggestedDepositTerms))
	)
		return { failure: quoteFailure(409, false, values) };
	const currency = data.financial.currency;
	const invalid = fieldFailure(values, currency);
	if (invalid) return invalid;
	return {
		context: {
			config,
			cookie,
			inquiryId: params.inquiryId,
			values,
			terms:
				values.deposit.depositChoice === 'suggested'
					? data.suggestedDepositTerms
					: reviewedTerms(values.deposit, currency),
			currency,
			effective,
			documentId: data.financial.id,
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
	const { config, cookie, inquiryId, values, terms, currency } = context;
	// Preview only the version the staff member reviewed, whatever a newer read might show.
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
	if (
		!isQuotePreview(result.data, { inquiryId, currency, documentId: context.documentId }) ||
		result.data.pricingBasis !== basis
	)
		return quoteFailure(503, false, values);
	return {
		preview: result.data,
		notices,
		quoteValues: {
			...values,
			reviewToken: result.data.reviewToken,
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
		const read = await readEnvelope(event);
		if ('failure' in read) return read.failure;
		const posted = postedContext(event, read.envelope);
		if ('failure' in posted) return posted.failure;
		const { values, effective } = posted.context;
		const basis = chooseBasis(values.service, effective);
		// Picks already found to change pricing reprice directly, without failing a revision first.
		if (basis === 'REVISE_SERVICE_SELECTIONS' && values.reviewedBasis === 'REPRICE_CONFIGURATION')
			return preview(posted.context, 'REPRICE_CONFIGURATION', { repriced: true });
		return preview(posted.context, basis);
	},
	issueQuote: async (event) => {
		const read = await readEnvelope(event);
		if ('failure' in read) return read.failure;
		const result = await authoritativeContext(event, read.envelope);
		if ('failure' in result) return result.failure;
		const context = result.context;
		const { values, terms, currency, effective } = context;
		const basis = chooseBasis(values.service, effective);
		const expectedDocumentVersion = Number(values.deposit.expectedVersion);
		// Only the exact previewed command may be issued; anything else is previewed again for review.
		if (
			!values.reviewToken ||
			!values.reviewedBasis ||
			!basisStillReviewed(values.reviewedBasis, basis)
		)
			return preview(context, basis, { reviewStale: true });
		const { composition } = buildComposition(values, values.reviewedBasis, currency);
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
