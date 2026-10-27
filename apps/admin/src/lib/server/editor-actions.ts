import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { applySetCookies } from './auth.js';
import { backendConfig } from './config.js';
import {
	getDepositRequirementHistory,
	getFinancialDocumentHistory,
	getStaffRequest,
	issueInquiryProposal,
	previewInquiryInvoiceRevision,
	previewInquiryQuote,
	previewInquiryQuoteRevision,
	reviseInquiryInvoice,
	reviseInquiryQuote
} from './staff-request.js';
import { reviewFingerprint } from './quote-review.js';
import { CURRENCY } from '../currency.js';
import { workspaceRedirect } from '../request-list.js';
import type { CurrentStaffRequest } from '../request-contract.js';
import {
	buildCommand,
	buildRevisionCommand,
	isInvoiceRevisionPreview,
	isQuotePreview,
	isQuoteRevisionPreview,
	previewMatchesSelections,
	quoteInputErrors,
	readQuoteForm,
	reviewedStateChanged,
	reviewedTerms,
	type EditorPreview,
	type QuoteActionResult,
	type QuoteFormValues
} from '../quote-builder.js';
import { planIntent } from '../service-plan-edit.js';
import {
	editorEligible,
	editorErrorMessage,
	isNoMaterialChange,
	type FinancialEditorMode
} from '../financial-editor.js';
import { isDepositRequirementHistory, isFinancialDocumentHistory } from '../revision-history.js';
import {
	hasInvoiceAmendmentPermissions,
	hasProposalPermissions,
	isCurrentStaffRequest
} from '../request-workspace.js';

/**
 * Optional detail: a failed or malformed history read is "unavailable" and never hides the booking.
 * Only the opaque statuses are logged, never a customer value.
 */
export async function loadHistory(
	event: Pick<RequestEvent, 'cookies' | 'request' | 'url'>,
	data: CurrentStaffRequest
) {
	const config = backendConfig(event.url.origin);
	const cookie = event.request.headers.get('cookie');
	const [documents, deposits] = await Promise.all([
		getFinancialDocumentHistory(config, data.financial.id, cookie),
		getDepositRequirementHistory(config, data.financial.id, cookie)
	]);
	if (
		(!documents.ok && documents.error.status === 401) ||
		(!deposits.ok && deposits.error.status === 401)
	)
		redirect(303, '/login');
	if (
		documents.ok &&
		deposits.ok &&
		isFinancialDocumentHistory(documents.data, {
			documentId: data.financial.id,
			inquiryId: data.inquiry.id,
			latestVersion: data.financial.version
		}) &&
		isDepositRequirementHistory(deposits.data, {
			documentId: data.financial.id,
			currency: data.financial.currency
		})
	) {
		applySetCookies(event.cookies, documents.setCookies);
		applySetCookies(event.cookies, deposits.setCookies);
		return { state: 'ready' as const, documents: documents.data, deposits: deposits.data };
	}
	console.error(
		`[request] ${data.inquiry.id} history unavailable: documents ${documents.ok ? 'malformed' : documents.error.status}, deposits ${deposits.ok ? 'malformed' : deposits.error.status}`
	);
	return { state: 'unavailable' as const };
}
export type RequestHistory = Awaited<ReturnType<typeof loadHistory>>;

export function editorFailure(
	mode: FinancialEditorMode,
	status: number,
	{
		values,
		attempted = false,
		violations = []
	}: { values?: QuoteFormValues; attempted?: boolean; violations?: readonly string[] } = {}
) {
	const noChange = isNoMaterialChange(violations);
	return fail(status >= 500 ? 503 : status, {
		quoteError:
			mode === 'INITIAL_QUOTE' && !attempted && status >= 500
				? 'We couldn’t preview this quote. Nothing was issued. Try again.'
				: editorErrorMessage(mode, status, violations, attempted),
		// A no-op or a correctable 422 is edited in place; anything the staff member could not
		// have caused (stale state, forbidden, an unconfirmed commit) requires a reload to review.
		reviewRequired:
			!noChange &&
			((attempted && status !== 400 && status !== 422) || status === 403 || status === 409),
		notices: noChange ? { noChange: true } : undefined,
		quoteValues: values
	} satisfies QuoteActionResult);
}

type InitialCommand = ReturnType<typeof buildCommand>;
type RevisionCommand = ReturnType<typeof buildRevisionCommand>;

/**
 * One handler for all three lifecycle modes. A preview is a query that writes nothing; publishing
 * is one attempt with the reviewed command and the preview's own token. The local fingerprint only
 * decides whether the posted form is still what was reviewed; the backend token remains the authority.
 */
export async function editorAction(
	event: RequestEvent,
	mode: FinancialEditorMode,
	publish: boolean
) {
	const { locals, request, url, params, cookies } = event;
	if (!locals.user) redirect(303, '/login');
	const permissions = locals.user.permissions;
	if (
		!(mode === 'INVOICE_AMENDMENT'
			? hasInvoiceAmendmentPermissions(permissions)
			: hasProposalPermissions(permissions))
	)
		return editorFailure(mode, 403);
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return editorFailure(mode, 422);
	}
	const parsed = readQuoteForm(form);
	// A form is for exactly the action it was posted to; modes never mix.
	if (!parsed || parsed.mode !== mode) return editorFailure(mode, 422);
	const values: QuoteFormValues = parsed;
	// A native selection edit (add, remove, reorder) only returns the complete draft; it may leave a
	// blank row to fill in, so Update preview is the explicit next step. Any review is cleared.
	if (form.has('selectionAction')) {
		if (publish) return editorFailure(mode, 422);
		return { quoteValues: { ...values, reviewToken: '', reviewedFingerprint: '' } };
	}
	const config = backendConfig(url.origin);
	const cookie = request.headers.get('cookie');
	const errors = quoteInputErrors(values);
	const invalid = () =>
		fail(422, {
			quoteError: 'Check the highlighted fields.',
			quoteValues: values,
			fieldErrors: errors,
			reviewRequired: false
		} satisfies QuoteActionResult);
	if (Object.keys(errors).length && !publish) return invalid();
	const version = Number(values.expectedVersion);
	// An initial preview is stateless. Everything else reads the authoritative state first:
	// revisions derive the plan action from the current approval and must still match what was reviewed.
	let current: CurrentStaffRequest | null = null;
	if (publish || mode !== 'INITIAL_QUOTE') {
		const read = await getStaffRequest(config, params.inquiryId!, cookie);
		if (!read.ok) {
			if (read.error.status === 401) redirect(303, '/login');
			return editorFailure(mode, read.error.status, { values, attempted: publish });
		}
		applySetCookies(cookies, read.setCookies);
		if (!isCurrentStaffRequest(read.data, params.inquiryId!))
			return editorFailure(mode, 503, { values, attempted: true });
		current = read.data;
		if (
			!editorEligible(mode, current, permissions) ||
			current.financial.currency !== CURRENCY ||
			reviewedStateChanged(values, current)
		)
			return editorFailure(mode, 409, { values, attempted: true });
	}
	if (Object.keys(errors).length) return invalid();
	let command: InitialCommand | RevisionCommand;
	if (mode === 'INITIAL_QUOTE') command = buildCommand(values);
	else {
		const intent = planIntent(values, current!);
		if (!intent.ok)
			return fail(422, {
				quoteError: intent.error,
				quoteValues: values,
				fieldErrors: { service: intent.error },
				reviewRequired: false
			} satisfies QuoteActionResult);
		command = buildRevisionCommand(values, intent);
	}
	const terms = values.deposit ? reviewedTerms(values.deposit) : undefined;
	const depositRevision = values.expectedDepositRevision
		? Number(values.expectedDepositRevision)
		: undefined;
	const planRevision = values.expectedPlanRevision ? Number(values.expectedPlanRevision) : null;
	const fingerprint = reviewFingerprint({
		mode,
		expectedDocumentVersion: version,
		expectedDepositRevision: depositRevision,
		expectedProposalId: values.expectedProposalId || undefined,
		expectedPlanRevision: planRevision,
		command,
		terms
	});
	const inquiryId = params.inquiryId!;
	function reject(result: { error: { status: number; violations: string[] } }) {
		if (result.error.status === 401) redirect(303, '/login');
		return editorFailure(mode, result.error.status, {
			values,
			violations: result.error.violations
		});
	}
	async function preview(stale = false) {
		let reviewed: EditorPreview | null = null;
		let token = '';
		let setCookies: string[] | undefined;
		const scope = { inquiryId };
		if (mode === 'INITIAL_QUOTE') {
			const result = await previewInquiryQuote(
				config,
				inquiryId,
				{ expectedDocumentVersion: version, ...(command as InitialCommand), terms: terms! },
				cookie
			);
			if (!result.ok) return reject(result);
			setCookies = result.setCookies;
			if (
				isQuotePreview(result.data, scope) &&
				result.data.reviewedDocumentVersion === version &&
				previewMatchesSelections(command, result.data)
			) {
				reviewed = { mode, quote: result.data };
				token = result.data.reviewToken;
			}
		} else if (mode === 'QUOTE_REVISION') {
			const result = await previewInquiryQuoteRevision(
				config,
				inquiryId,
				{
					expectedDocumentVersion: version,
					expectedDepositRequirementRevision: depositRevision!,
					...(command as RevisionCommand),
					terms: terms!
				},
				cookie
			);
			if (!result.ok) return reject(result);
			setCookies = result.setCookies;
			const data = result.data;
			if (
				isQuoteRevisionPreview(data, { ...scope, documentId: current!.financial.id }) &&
				data.quote.reviewedDocumentVersion === version &&
				data.reviewedDepositRequirementRevision === depositRevision &&
				data.currentProposalId === values.expectedProposalId &&
				(data.currentServicePlanRevision ?? null) === planRevision &&
				previewMatchesSelections(command, data.quote)
			) {
				reviewed = { mode, revision: data };
				token = data.quote.reviewToken;
			}
		} else {
			const result = await previewInquiryInvoiceRevision(
				config,
				inquiryId,
				{ expectedDocumentVersion: version, ...(command as RevisionCommand) },
				cookie
			);
			if (!result.ok) return reject(result);
			setCookies = result.setCookies;
			const data = result.data;
			if (
				isInvoiceRevisionPreview(data, { ...scope, documentId: current!.financial.id }) &&
				data.reviewedDocumentVersion === version &&
				(data.currentServicePlanRevision ?? null) === planRevision &&
				previewMatchesSelections(command, data)
			) {
				reviewed = { mode, invoice: data };
				token = data.reviewToken;
			}
		}
		// A response that contradicts what was asked is unavailable, never a preview to approve.
		if (!reviewed || !setCookies) return editorFailure(mode, 503, { values });
		applySetCookies(cookies, setCookies);
		return {
			preview: reviewed,
			quoteValues: { ...values, reviewToken: token, reviewedFingerprint: fingerprint },
			notices: { reviewStale: stale },
			reviewRequired: false
		};
	}
	if (!publish) return preview();
	if (!values.reviewToken || fingerprint !== values.reviewedFingerprint) return preview(true);
	// Exactly one attempt. A stale review is never re-tokened and resubmitted: it returns a fresh
	// preview for a human to approve, and any other failure after this point is a review state.
	const result =
		mode === 'INITIAL_QUOTE'
			? await issueInquiryProposal(config, inquiryId, version, terms!, cookie, {
					...(command as InitialCommand),
					reviewToken: values.reviewToken
				})
			: mode === 'QUOTE_REVISION'
				? await reviseInquiryQuote(
						config,
						inquiryId,
						{
							expectedDocumentVersion: version,
							expectedDepositRequirementRevision: depositRevision!,
							...(command as RevisionCommand),
							terms: terms!,
							reviewToken: values.reviewToken
						},
						cookie
					)
				: await reviseInquiryInvoice(
						config,
						inquiryId,
						{
							expectedDocumentVersion: version,
							...(command as RevisionCommand),
							reviewToken: values.reviewToken
						},
						cookie
					);
	if (!result.ok) {
		if (result.error.status === 401) redirect(303, '/login');
		if (result.error.code === 'QUOTE_REVIEW_STALE') return preview(true);
		return editorFailure(mode, result.error.status, {
			values,
			attempted: true,
			violations: result.error.violations
		});
	}
	applySetCookies(cookies, result.setCookies);
	redirect(303, workspaceRedirect(url));
}
