import type {
	InquiryLifecycle,
	StaffRequestResponse,
	CurrentStaffRequest
} from './request-contract.js';
import { isSupportedCurrency } from './currency.js';
import { isDepositTerms } from './deposit.js';
import { isPaymentHistory } from './payment-history.js';

export const PROPOSAL_PERMISSIONS = [
	'commerce.financial-document.create',
	'commerce.deposit-requirement.manage',
	'fionas.financial-terms.manage'
] as const;
export function hasProposalPermissions(permissions: string[]): boolean {
	return PROPOSAL_PERMISSIONS.every((permission) => permissions.includes(permission));
}
export const lifecycleStages = ['REQUESTED', 'QUOTED', 'BOOKED', 'SERVED', 'CLOSED'] as const;

export const FULFILLMENT_PERMISSION = 'fionas.inquiries.manage';
export type FulfillmentAction = 'markServed' | 'closeInquiry';
export function hasFulfillmentPermission(permissions: string[]): boolean {
	return permissions.includes(FULFILLMENT_PERMISSION);
}
/** Decimal-string comparison, with no rounding or currency conversion. */
export function isExactZero(value: string): boolean {
	return /^-?0+(?:\.0+)?$/.test(value);
}
export function canMarkServed(data: StaffRequestResponse, permissions: string[]): boolean {
	return (
		hasFulfillmentPermission(permissions) &&
		isCurrentStaffRequest(data, data.inquiry.id) &&
		data.inquiry.lifecycle.stage === 'BOOKED' &&
		data.financial.stage === 'INVOICE'
	);
}
export function canCloseInquiry(data: StaffRequestResponse, permissions: string[]): boolean {
	return (
		hasFulfillmentPermission(permissions) &&
		isCurrentStaffRequest(data, data.inquiry.id) &&
		data.inquiry.lifecycle.stage === 'SERVED' &&
		data.financial.stage === 'INVOICE' &&
		isExactZero(data.financial.reconciliation.balance)
	);
}
export function fulfillmentErrorMessage(
	status: number,
	action: FulfillmentAction,
	mutationAttempted = false
): string {
	if (status === 403) return 'This account cannot update event fulfillment.';
	if (status === 404)
		return 'This request is no longer available. Reload to review the latest state.';
	if (status === 409)
		return action === 'markServed'
			? 'This request changed since you opened it. Reload to review whether the event can still be marked served.'
			: 'This request changed since you opened it. Reload to review the latest balance and lifecycle before closing.';
	if (status >= 500 && mutationAttempted)
		return action === 'markServed'
			? 'We couldn’t confirm whether the event was marked served. Reload to review the latest state before trying again.'
			: 'We couldn’t confirm whether the event was closed. Reload to review the latest state before trying again.';
	return 'We couldn’t review the latest request state. Reload before trying again.';
}

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
			: `Event ${lifecycleLabel(stage).toLowerCase()}`;
}
export function requestSummaryDescription(data: CurrentStaffRequest): string {
	const stage = data.inquiry.lifecycle.stage;
	if (stage === 'REQUESTED') return 'Review the current Estimate below before issuing a quote.';
	if (stage === 'QUOTED')
		return 'The full approved deposit is required to hold the date and book this event.';
	if (stage === 'CLOSED')
		return 'Service and payment are complete. Review the financial and payment history below.';
	if (stage === 'SERVED') {
		const balance = data.financial.reconciliation.balance;
		if (isExactZero(balance)) return 'The Invoice is settled and this event may be closed.';
		return balance.startsWith('-')
			? 'The Invoice balance must be exactly zero before closing this event.'
			: 'This event has been served. Record the remaining payment before closing it.';
	}
	return 'Review the current Invoice and any remaining balance below.';
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
		Array.isArray(data.payments) &&
		data.payments.every(isPaymentHistory) &&
		typeof data.financial.reconciliation?.balance === 'string' &&
		/^-?\d+(?:\.\d+)?$/.test(data.financial.reconciliation.balance) &&
		typeof data.financial.reconciliation.currency === 'string'
	))
		return false;
	const { inquiry, financial, proposal, depositRequirement: deposit } = data;
	if (
		!inquiry.requestedService ||
		!Number.isInteger(inquiry.requestedService.guestCount) ||
		inquiry.requestedService.guestCount < 1 ||
		!Array.isArray(inquiry.requestedService.items) ||
		!inquiry.requestedService.items.every(
			(i) => i && typeof i.label === 'string' && !!i.label.trim()
		) ||
		typeof inquiry.requestedService.guestCountIsMinimum !== 'boolean' ||
		!financial.linesAuthoredBy ||
		!['USER', 'SERVICE'].includes(financial.linesAuthoredBy.principalKind) ||
		typeof financial.linesAuthoredBy.principalId !== 'string' ||
		!financial.linesAuthoredBy.principalId ||
		typeof financial.linesAuthoredBy.recordedAt !== 'string' ||
		!Number.isFinite(Date.parse(financial.linesAuthoredBy.recordedAt)) ||
		financial.lines.length === 0 ||
		!financial.lines.every((l) => l && typeof l === 'object') ||
		![financial.subtotal, financial.taxAmount, financial.total].every(
			(a) => typeof a === 'string' && /^-?\d+(\.\d+)?$/.test(a)
		) ||
		new Set(financial.lines.map((l) => l.id)).size !== financial.lines.length ||
		!financial.lines.every(
			(l) =>
				typeof l.id === 'string' &&
				!!l.id &&
				typeof l.description === 'string' &&
				[l.unitPrice, l.subtotal, l.taxAmount, l.total].every(
					(a) => typeof a === 'string' && /^-?\d+(\.\d+)?$/.test(a)
				) &&
				l.currency === financial.currency
		)
	)
		return false;
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
		return (
			financial.stage === 'ESTIMATE' &&
			proposal == null &&
			deposit.state === 'NONE' &&
			data.servicePlan == null
		);
	if (
		!proposal ||
		typeof proposal.id !== 'string' ||
		!proposal.id ||
		proposal.inquiryId !== inquiry.id ||
		proposal.documentId !== financial.id ||
		!version(proposal.documentVersion) ||
		!version(proposal.depositRequirementRevision) ||
		!instant(proposal.issuedAt) ||
		typeof proposal.issuedBy !== 'string' ||
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
	if (!isCoherentServicePlan(data.servicePlan, data as CurrentStaffRequest)) return false;
	return inquiry.lifecycle.stage === 'QUOTED'
		? financial.stage === 'QUOTE' && financial.version === proposal.documentVersion
		: ['BOOKED', 'SERVED', 'CLOSED'].includes(inquiry.lifecycle.stage) &&
				financial.stage === 'INVOICE' &&
				financial.version > proposal.documentVersion;
}

/**
 * An approved plan belongs to exactly the latest proposal's Quote. While that Quote is current its
 * lines are the plan's lines, in order. Absent is legitimate (deposit-only issuance); contradictory is not.
 */
function isCoherentServicePlan(
	plan: StaffRequestResponse['servicePlan'],
	data: CurrentStaffRequest
): boolean {
	if (plan == null) return true;
	const { financial, proposal } = data;
	return (
		!!proposal &&
		plan.documentId === financial.id &&
		plan.documentVersion === proposal.documentVersion &&
		Number.isInteger(plan.reviewedDocumentVersion) &&
		plan.reviewedDocumentVersion > 0 &&
		plan.reviewedDocumentVersion < plan.documentVersion &&
		typeof plan.description === 'string' &&
		!!plan.description.trim() &&
		typeof plan.approvedBy === 'string' &&
		!!plan.approvedBy &&
		Number.isFinite(Date.parse(plan.approvedAt)) &&
		Array.isArray(plan.items) &&
		plan.items.every((item) => typeof item === 'string') &&
		Array.isArray(plan.lineNotes) &&
		new Set(plan.lineNotes.map((n) => n.lineItemId)).size === plan.lineNotes.length &&
		plan.lineNotes.every(
			(n) =>
				typeof n.lineItemId === 'string' &&
				typeof n.note === 'string' &&
				(financial.version !== plan.documentVersion ||
					financial.lines.some((l) => l.id === n.lineItemId))
		)
	);
}
export function isProposalEligible(data: StaffRequestResponse): boolean {
	return (
		data.inquiry.lifecycle.stage === 'REQUESTED' &&
		data.financial.stage === 'ESTIMATE' &&
		data.proposal == null &&
		data.depositRequirement.state === 'NONE' &&
		isSupportedCurrency(data.financial.currency)
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
	if (status === 422)
		return 'These quote details couldn’t be accepted. Check the amounts and deposit terms, then preview again.';
	if (status === 400)
		return 'This quote couldn’t be read. Reload to review the request before trying again.';
	if (status === 409)
		return 'This request changed since you opened it. Reload to review the latest version before trying again.';
	if (status >= 500)
		return 'We couldn’t confirm whether the quote was issued. Reload to review the latest state before trying again.';
	return 'We couldn’t issue this quote. Reload to review the request before trying again.';
}
