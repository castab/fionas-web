import type {
	InquiryLifecycle,
	StaffRequestResponse,
	CurrentStaffRequest
} from './request-contract.js';

export const QUOTE_PERMISSION = 'commerce.financial-document.create';
export const lifecycleStages = ['REQUESTED', 'QUOTED', 'BOOKED', 'SERVED', 'CLOSED'] as const;

const lifecycleLabels: Record<InquiryLifecycle['stage'], string> = {
	REQUESTED: 'Requested',
	QUOTED: 'Quoted',
	BOOKED: 'Booked',
	SERVED: 'Served',
	CLOSED: 'Closed'
};
export function lifecycleLabel(stage: InquiryLifecycle['stage']): string {
	return lifecycleLabels[stage];
}
export function requestSummary(stage: InquiryLifecycle['stage']): string {
	return stage === 'REQUESTED'
		? 'Needs a quote'
		: stage === 'QUOTED'
			? 'Quote issued'
			: lifecycleLabel(stage);
}
export function financialStageLabel(stage: string): string {
	return (
		({ ESTIMATE: 'Estimate', QUOTE: 'Quote', INVOICE: 'Invoice' } as Record<string, string>)[
			stage
		] ?? 'Financial document'
	);
}

/** A partial/inconsistent projection is unavailable, never a zero balance or another inquiry's document. */
export function isCurrentStaffRequest(
	data: StaffRequestResponse | null,
	inquiryId: string
): data is CurrentStaffRequest {
	return (
		!!data &&
		data.inquiry?.id === inquiryId &&
		data.financial?.inquiryId === inquiryId &&
		typeof data.financial.id === 'string' &&
		data.inquiry.lifecycle?.documentId === data.financial.id &&
		Array.isArray(data.financial.lines) &&
		typeof data.financial.reconciliation?.balance === 'string' &&
		typeof data.financial.reconciliation.currency === 'string'
	);
}
export function isQuoteEligible(data: StaffRequestResponse): boolean {
	return data.inquiry.lifecycle.stage === 'REQUESTED' && data.financial.stage === 'ESTIMATE';
}
export function canIssueQuote(data: StaffRequestResponse, permissions: string[]): boolean {
	return isQuoteEligible(data) && permissions.includes(QUOTE_PERMISSION);
}
export type RequestError = 'forbidden' | 'not-found' | 'unavailable';
export function requestErrorKind(status: number): RequestError {
	return status === 403
		? 'forbidden'
		: status === 400 || status === 404
			? 'not-found'
			: 'unavailable';
}
export function requestErrorMessage(kind: RequestError): string {
	return kind === 'forbidden'
		? 'This account cannot view this request.'
		: kind === 'not-found'
			? 'This request could not be found.'
			: 'We couldn’t load this request. Try again shortly.';
}
export function quoteErrorMessage(status: number): string {
	if (status === 403) return 'This account cannot issue a quote for this request.';
	if (status === 404)
		return 'This request or its financial document is no longer available. Reload to review the latest state.';
	if (status === 409)
		return 'This request changed since you opened it. Reload to review the latest version before trying again.';
	if (status >= 500)
		return 'We couldn’t confirm whether the quote was issued. Reload to review the latest state before trying again.';
	return 'We couldn’t issue this quote. Reload to review the request before trying again.';
}
