import type {
	InquiryLifecycle,
	StaffRequestResponse,
	CurrentStaffRequest
} from './request-contract.js';
import { isDepositTerms } from './deposit.js';

export const PROPOSAL_PERMISSIONS = [
	'commerce.financial-document.create',
	'commerce.deposit-requirement.manage'
] as const;
export function hasProposalPermissions(permissions: string[]): boolean {
	return PROPOSAL_PERMISSIONS.every((permission) => permissions.includes(permission));
}
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
	if (!(
		!!data &&
		data.inquiry?.id === inquiryId &&
		data.financial?.inquiryId === inquiryId &&
		typeof data.financial.id === 'string' &&
		data.inquiry.lifecycle?.documentId === data.financial.id &&
		Array.isArray(data.financial.lines) &&
		typeof data.financial.reconciliation?.balance === 'string' &&
		typeof data.financial.reconciliation.currency === 'string'
	))
		return false;
	const { inquiry, financial, proposal, depositRequirement: deposit } = data;
	const version = (value: unknown) =>
		typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
	const instant = (value: unknown) =>
		typeof value === 'string' &&
		/^\d{4}-\d\d-\d\dT/.test(value) &&
		Number.isFinite(Date.parse(value));
	if (
		!version(financial.version) ||
		financial.reconciliation!.currency !== financial.currency ||
		typeof financial.currency !== 'string' ||
		!/^[A-Z]{3}$/.test(financial.currency) ||
		!isDepositTerms(data.suggestedDepositTerms, financial.currency) ||
		!deposit ||
		deposit.documentId !== financial.id
	)
		return false;
	if (inquiry.lifecycle.stage === 'REQUESTED')
		return financial.stage === 'ESTIMATE' && proposal == null && deposit.state === 'NONE';
	if (
		!proposal ||
		typeof proposal.id !== 'string' ||
		!proposal.id ||
		proposal.inquiryId !== inquiry.id ||
		proposal.documentId !== financial.id ||
		!version(proposal.documentVersion) ||
		!version(proposal.depositRequirementRevision) ||
		!instant(proposal.issuedAt) ||
		typeof proposal.principalKind !== 'string' ||
		typeof proposal.principalId !== 'string' ||
		typeof proposal.issuanceKind !== 'string'
	)
		return false;
	if (
		deposit.state !== 'ACTIVE' ||
		!version(deposit.revision) ||
		deposit.revision !== proposal.depositRequirementRevision ||
		deposit.approvalDocumentVersion !== proposal.documentVersion ||
		!instant(deposit.createdAt) ||
		!isDepositTerms(deposit.terms, financial.currency) ||
		!deposit.requiredAmount ||
		typeof deposit.requiredAmount.amount !== 'string' ||
		!/^\d+(?:\.\d+)?$/.test(deposit.requiredAmount.amount) ||
		deposit.requiredAmount.currency !== financial.currency ||
		typeof deposit.satisfied !== 'boolean' ||
		(deposit.previousRevision !== undefined &&
			(!version(deposit.previousRevision) || deposit.previousRevision >= deposit.revision))
	)
		return false;
	return inquiry.lifecycle.stage === 'QUOTED'
		? financial.stage === 'QUOTE' && financial.version === proposal.documentVersion
		: ['BOOKED', 'SERVED', 'CLOSED'].includes(inquiry.lifecycle.stage) &&
				financial.stage === 'INVOICE' &&
				financial.version > proposal.documentVersion;
}
export function isProposalEligible(data: StaffRequestResponse): boolean {
	return (
		data.inquiry.lifecycle.stage === 'REQUESTED' &&
		data.financial.stage === 'ESTIMATE' &&
		data.proposal == null &&
		data.depositRequirement.state === 'NONE'
	);
}
export function canIssueQuote(data: StaffRequestResponse, permissions: string[]): boolean {
	return isProposalEligible(data) && hasProposalPermissions(permissions);
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
		return 'This request is no longer available. Reload to review the latest state.';
	if (status === 400 || status === 422)
		return 'Enter a valid deposit percentage or amount before issuing the quote.';
	if (status === 409)
		return 'This request changed since you opened it. Reload to review the latest version before trying again.';
	if (status >= 500)
		return 'We couldn’t confirm whether the quote was issued. Reload to review the latest state before trying again.';
	return 'We couldn’t issue this quote. Reload to review the request before trying again.';
}
