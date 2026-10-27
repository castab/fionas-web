import { fail, redirect } from '@sveltejs/kit';
import { applySetCookies } from '$lib/server/auth.js';
import { backendConfig } from '$lib/server/config.js';
import {
	getStaffRequest,
	previewInquiryQuote,
	recordPayment,
	markInquiryServed,
	closeInquiry,
	declineInquiry
} from '$lib/server/staff-request.js';
import { reviewFingerprint } from '$lib/server/quote-review.js';
import { editorAction, loadHistory } from '$lib/server/editor-actions.js';
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
import { businessDate } from '$lib/presentation.js';
import { readReturnContext, workspaceRedirect } from '$lib/request-list.js';
import {
	declineErrorMessage,
	declineReason,
	declineReasonMessage,
	declineReasonProblem,
	readDeclineForm,
	type DeclineFormValues
} from '$lib/decline.js';
import {
	buildCommand,
	editorValues,
	isQuotePreview,
	type QuoteActionResult
} from '$lib/quote-builder.js';
import { editorActions, openEditorMode } from '$lib/financial-editor.js';
import {
	canMarkServed,
	canCloseInquiry,
	canDeclineInquiry,
	describeRejectedStaffRequest,
	INQUIRY_MANAGE_PERMISSION,
	hasFulfillmentPermission,
	fulfillmentErrorMessage,
	type FulfillmentAction,
	isCurrentStaffRequest,
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
	const editorFlags = {
		INITIAL_QUOTE: quoteOpen,
		QUOTE_REVISION: url.searchParams.has('quote-revision'),
		INVOICE_AMENDMENT: url.searchParams.has('invoice-revision')
	};
	const historyOpen = url.searchParams.has('history');
	const paymentOpen = url.searchParams.has('payment');
	const declineOpen = url.searchParams.has('decline');
	// Opened from the Requests index: its validated filter/search/cursor, for Back to requests.
	const returnContext = readReturnContext(url.searchParams);
	const today = businessDate(new Date());
	const result = await getStaffRequest(config, params.inquiryId, cookie);
	if (!result.ok && result.error.status === 401) redirect(303, '/login');
	if (!result.ok || !isCurrentStaffRequest(result.data, params.inquiryId)) {
		// Operator hint only: why this page is unavailable. Statuses and field shapes, no customer data.
		console.error(
			result.ok
				? `[request] ${params.inquiryId} refused by the read-model validator: ${JSON.stringify(describeRejectedStaffRequest(result.data, params.inquiryId))}`
				: `[request] ${params.inquiryId} backend ${result.error.status} ${result.error.code}`
		);
		return {
			inquiryId: params.inquiryId,
			staffRequest: null,
			requestError: result.ok ? ('unavailable' as const) : requestErrorKind(result.error.status),
			quoteOpen,
			editorMode: null,
			historyOpen,
			history: null,
			paymentOpen,
			declineOpen,
			returnContext,
			today,
			initialQuote: null
		};
	}
	applySetCookies(cookies, result.setCookies);
	const data = result.data;
	const permissions = locals.user?.permissions ?? [];
	// At most one editor opens, and only the one this lifecycle makes eligible: a stale or mismatched
	// flag opens nothing and exposes no action.
	const editorMode = openEditorMode(data, permissions, editorFlags);
	let initialQuote: QuoteActionResult | null = null;
	// Only a first Quote opens already previewed. A revision or amendment starts from the current,
	// unchanged state, which the backend rightly refuses as "no material change".
	if (editorMode === 'INITIAL_QUOTE' && request.method === 'GET') {
		const values = editorValues(data, 'INITIAL_QUOTE');
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
				preview: { mode: 'INITIAL_QUOTE', quote: opening.data },
				quoteValues: {
					...values,
					reviewToken: opening.data.reviewToken,
					reviewedFingerprint: reviewFingerprint({
						mode: 'INITIAL_QUOTE',
						expectedDocumentVersion: data.financial.version,
						command,
						terms
					})
				}
			};
		}
	}
	// Optional detail: loaded only when `?history` is open, and its failure never hides the booking.
	const history = historyOpen ? await loadHistory({ cookies, request, url }, data) : null;
	return {
		inquiryId: params.inquiryId,
		staffRequest: data,
		requestError: null,
		quoteOpen,
		editorMode,
		historyOpen,
		history,
		paymentOpen,
		declineOpen,
		returnContext,
		today,
		initialQuote
	};
};
export const actions: Actions = {
	markServed: fulfillmentAction('markServed'),
	closeInquiry: fulfillmentAction('closeInquiry'),
	recordDeposit: paymentAction(true),
	recordInvoicePayment: paymentAction(false),
	declineInquiry: declineAction,
	[editorActions.INITIAL_QUOTE.preview]: (event) => editorAction(event, 'INITIAL_QUOTE', false),
	[editorActions.INITIAL_QUOTE.publish]: (event) => editorAction(event, 'INITIAL_QUOTE', true),
	[editorActions.QUOTE_REVISION.preview]: (event) => editorAction(event, 'QUOTE_REVISION', false),
	[editorActions.QUOTE_REVISION.publish]: (event) => editorAction(event, 'QUOTE_REVISION', true),
	[editorActions.INVOICE_AMENDMENT.preview]: (event) =>
		editorAction(event, 'INVOICE_AMENDMENT', false),
	[editorActions.INVOICE_AMENDMENT.publish]: (event) =>
		editorAction(event, 'INVOICE_AMENDMENT', true)
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
		redirect(303, workspaceRedirect(url));
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
		redirect(303, workspaceRedirect(url));
	};
}

/**
 * Declines a REQUESTED inquiry the staff member reviewed. The route names the inquiry and the
 * session the actor; the form carries only the reviewed Estimate version and the internal reason.
 * A changed version is refused here, never replaced with the freshly read one. Exactly one
 * backend attempt: any failure after it is a review state, never a retry.
 */
async function declineAction({ params, locals, request, url, cookies }: RequestEvent) {
	if (!locals.user) redirect(303, '/login');
	const failure = (
		status: number,
		{
			attempted = false,
			values,
			correctable = false
		}: { attempted?: boolean; values?: DeclineFormValues; correctable?: boolean } = {}
	) =>
		fail(status >= 500 ? 503 : status, {
			declineError: declineErrorMessage(status, attempted),
			declineReviewRequired: !correctable,
			declineValues: values
		});
	if (!locals.user.permissions.includes(INQUIRY_MANAGE_PERMISSION)) return failure(403);
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return failure(400);
	}
	const values = readDeclineForm(form);
	if (!values) return failure(400);
	const problem = declineReasonProblem(values.reason);
	if (problem)
		return fail(422, {
			declineError: declineReasonMessage(problem),
			declineReviewRequired: false,
			declineValues: values,
			declineField: 'reason' as const
		});
	const config = backendConfig(url.origin);
	const cookie = request.headers.get('cookie');
	const current = await getStaffRequest(config, params.inquiryId, cookie);
	if (!current.ok) {
		if (current.error.status === 401) redirect(303, '/login');
		return failure(current.error.status, { values });
	}
	applySetCookies(cookies, current.setCookies);
	if (!isCurrentStaffRequest(current.data, params.inquiryId)) return failure(503, { values });
	if (
		!canDeclineInquiry(current.data, locals.user.permissions) ||
		String(current.data.financial.version) !== values.expectedDocumentVersion
	)
		return failure(409, { values });
	const result = await declineInquiry(
		config,
		params.inquiryId,
		{
			expectedDocumentVersion: Number(values.expectedDocumentVersion),
			reason: declineReason(values.reason)
		},
		cookie
	);
	if (!result.ok) {
		if (result.error.status === 401) redirect(303, '/login');
		// Validation refusals record nothing, so the reason stays correctable.
		if (result.error.status === 422)
			return failure(422, { attempted: true, values, correctable: true });
		return failure(result.error.status, { attempted: true, values });
	}
	applySetCookies(cookies, result.setCookies);
	redirect(303, workspaceRedirect(url));
}
