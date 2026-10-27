import { isSupportedCurrency } from './currency.js';
import type { CurrentStaffRequest } from './request-contract.js';
import {
	hasInvoiceAmendmentPermissions,
	hasProposalPermissions,
	isCurrentStaffRequest,
	quoteErrorMessage
} from './request-workspace.js';

/**
 * The one financial/service editor serves three lifecycle moments. Each is a different backend
 * operation with a different revision identity, but staff see one continuous booking workflow.
 *
 * - INITIAL_QUOTE: REQUESTED, on the canonical Estimate; terms are chosen here.
 * - QUOTE_REVISION: QUOTED, before the deposit is paid; terms are still editable.
 * - INVOICE_AMENDMENT: BOOKED or SERVED; the accepted deposit is immutable and never edited.
 */
export type FinancialEditorMode = 'INITIAL_QUOTE' | 'QUOTE_REVISION' | 'INVOICE_AMENDMENT';
export const EDITOR_MODES: readonly FinancialEditorMode[] = [
	'INITIAL_QUOTE',
	'QUOTE_REVISION',
	'INVOICE_AMENDMENT'
];
export const isEditorMode = (value: unknown): value is FinancialEditorMode =>
	EDITOR_MODES.includes(value as FinancialEditorMode);

/** Whether the mode edits deposit terms. Invoice amendments never do. */
export const editsDeposit = (mode: FinancialEditorMode) => mode !== 'INVOICE_AMENDMENT';
/** Revisions choose RETAIN / REPLACE / CLEAR for the current service commitment. */
export const isRevision = (mode: FinancialEditorMode) => mode !== 'INITIAL_QUOTE';

/** The `?flag` that opens each editor, stable and reloadable. */
export const editorPanels = {
	INITIAL_QUOTE: 'quote',
	QUOTE_REVISION: 'quote-revision',
	INVOICE_AMENDMENT: 'invoice-revision'
} as const;

/** Action names on the workspace's form actions, per mode. */
export const editorActions = {
	INITIAL_QUOTE: { preview: 'previewQuote', publish: 'issueQuote' },
	QUOTE_REVISION: { preview: 'previewQuoteRevision', publish: 'reviseQuote' },
	INVOICE_AMENDMENT: { preview: 'previewInvoiceRevision', publish: 'amendInvoice' }
} as const;

export type EditorCopy = {
	/** The workspace button that opens the editor. */
	open: string;
	title: string;
	intro: (customer: string) => string;
	previewHeading: string;
	publish: string;
	/** What the Publish button is called in a sentence ("click Issue quote again"). */
	publishVerb: string;
	pendingPreview: string;
	/** The preview's pill: what is about to exist and that it does not yet. */
	notYet: string;
};
export const editorCopy: Record<FinancialEditorMode, EditorCopy> = {
	INITIAL_QUOTE: {
		open: 'Build quote',
		title: 'Issue quote',
		intro: (customer) =>
			`Edit the final lines ${customer} will see. Totals and the deposit come back from the preview — check it before issuing.`,
		previewHeading: 'Quote preview',
		publish: 'Issue quote',
		publishVerb: 'Issue quote',
		pendingPreview: 'Preview required for current edits.',
		notYet: 'not issued yet'
	},
	QUOTE_REVISION: {
		open: 'Revise quote',
		title: 'Revise quote',
		intro: (customer) =>
			`${customer} hasn’t paid the deposit yet, so the quote, the serving plan and the deposit terms can all still change. Totals come back from the preview — check it before publishing.`,
		previewHeading: 'Revised quote preview',
		publish: 'Publish revised quote',
		publishVerb: 'Publish revised quote',
		pendingPreview: 'Preview required for current edits.',
		notYet: 'not published yet'
	},
	INVOICE_AMENDMENT: {
		open: 'Amend invoice',
		title: 'Amend invoice',
		intro: (customer) =>
			`${customer}’s deposit is accepted and stays as it was. Additional charges or reductions change the invoice balance; payments already recorded stay applied.`,
		previewHeading: 'Invoice amendment preview',
		publish: 'Approve invoice amendment',
		publishVerb: 'Approve invoice amendment',
		pendingPreview: 'Preview required for current edits.',
		notYet: 'not approved yet'
	}
};

/** A revision is meaningful only while the deposit is unpaid. */
export function canReviseQuote(data: CurrentStaffRequest | null, permissions: string[]): boolean {
	return (
		!!data &&
		hasProposalPermissions(permissions) &&
		isCurrentStaffRequest(data, data.inquiry.id) &&
		data.inquiry.lifecycle.stage === 'QUOTED' &&
		data.financial.stage === 'QUOTE' &&
		data.depositRequirement.state === 'ACTIVE' &&
		!data.depositRequirement.satisfied &&
		!!data.proposal &&
		isSupportedCurrency(data.financial.currency)
	);
}
/** Booked and served events can still be amended; CLOSED and DECLINED are read-only. */
export function canAmendInvoice(data: CurrentStaffRequest | null, permissions: string[]): boolean {
	return (
		!!data &&
		hasInvoiceAmendmentPermissions(permissions) &&
		isCurrentStaffRequest(data, data.inquiry.id) &&
		['BOOKED', 'SERVED'].includes(data.inquiry.lifecycle.stage) &&
		data.financial.stage === 'INVOICE' &&
		isSupportedCurrency(data.financial.currency)
	);
}

/**
 * The editor flags present in the URL, resolved deterministically: a flag opens its editor only when
 * that mode is eligible for this request now, so a stale or hand-written `?quote` on a QUOTED
 * request opens nothing, and at most one editor can ever be open (the lifecycle picks it).
 */
export function openEditorMode(
	data: CurrentStaffRequest | null,
	permissions: string[],
	flags: Partial<Record<FinancialEditorMode, boolean>>
): FinancialEditorMode | null {
	if (!data) return null;
	const stage = data.inquiry.lifecycle.stage;
	if (
		flags.INITIAL_QUOTE &&
		stage === 'REQUESTED' &&
		editorEligible('INITIAL_QUOTE', data, permissions)
	)
		return 'INITIAL_QUOTE';
	if (flags.QUOTE_REVISION && editorEligible('QUOTE_REVISION', data, permissions))
		return 'QUOTE_REVISION';
	if (flags.INVOICE_AMENDMENT && editorEligible('INVOICE_AMENDMENT', data, permissions))
		return 'INVOICE_AMENDMENT';
	return null;
}
/** Which editor, if any, this request's lifecycle offers this staff member. */
export function availableEditorMode(
	data: CurrentStaffRequest | null,
	permissions: string[]
): FinancialEditorMode | null {
	return EDITOR_MODES.find((mode) => !!data && editorEligible(mode, data, permissions)) ?? null;
}
export function editorEligible(
	mode: FinancialEditorMode,
	data: CurrentStaffRequest,
	permissions: string[]
): boolean {
	return mode === 'INITIAL_QUOTE'
		? hasProposalPermissions(permissions) &&
				isCurrentStaffRequest(data, data.inquiry.id) &&
				data.inquiry.lifecycle.stage === 'REQUESTED' &&
				data.financial.stage === 'ESTIMATE' &&
				data.proposal == null &&
				data.depositRequirement.state === 'NONE' &&
				isSupportedCurrency(data.financial.currency)
		: mode === 'QUOTE_REVISION'
			? canReviseQuote(data, permissions)
			: canAmendInvoice(data, permissions);
}

const NO_CHANGE = 'NO_MATERIAL_CHANGE';
/**
 * Plain-language outcome for a failed preview or publication. `violations` are the backend's stable
 * codes. A no-op is guidance, not a publication; a 5xx on publication is unconfirmed.
 */
export function editorErrorMessage(
	mode: FinancialEditorMode,
	status: number,
	violations: readonly string[] = [],
	attempted = false
): string {
	if (mode === 'INITIAL_QUOTE') return quoteErrorMessage(status);
	const noun = mode === 'QUOTE_REVISION' ? 'revised quote' : 'invoice amendment';
	if (status === 403)
		return mode === 'QUOTE_REVISION'
			? 'This account cannot revise quotes.'
			: 'This account cannot amend invoices.';
	if (status === 404)
		return 'This request is no longer available. Reload to review the latest state.';
	if (status === 422 && violations.includes(NO_CHANGE))
		return 'Nothing has changed. Update the pricing or service details before publishing a new version.';
	if (status === 422 && violations.includes('SERVICE_PLAN_LINE_NOT_FOUND'))
		return 'A service note refers to a line that was removed. Update the service plan so every note matches a remaining line, then preview again.';
	if (status === 422 && violations.includes('NEGATIVE_DOCUMENT_TOTAL'))
		return 'The document total can’t go below zero. Adjust the lines, then preview again.';
	if (status === 422 && violations.includes('QUOTE_TOTAL_NOT_POSITIVE'))
		return 'A quote total must be greater than zero. Adjust the lines, then preview again.';
	if (status === 422)
		return `These ${noun} details couldn’t be accepted. Check the amounts and service plan, then preview again.`;
	if (status === 400)
		return `This ${noun} couldn’t be read. Reload to review the request before trying again.`;
	if (status === 409)
		return 'This booking changed since you opened it. Reload to review the latest version before trying again.';
	if (status >= 500)
		return attempted
			? `We couldn’t confirm whether the ${noun} was saved. Reload to review the latest state before trying again.`
			: `We couldn’t preview this ${noun}. Nothing was changed. Try again.`;
	return `We couldn’t review this ${noun}. Reload to review the request before trying again.`;
}
export const isNoMaterialChange = (violations: readonly string[]) => violations.includes(NO_CHANGE);
