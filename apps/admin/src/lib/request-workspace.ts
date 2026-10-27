import { isRequestedItem, isServicePlanItems } from './service-selections.js';
import type {
	InquiryStage,
	StaffRequestResponse,
	CurrentStaffRequest
} from './request-contract.js';
import { isSupportedCurrency } from './currency.js';
import { isDepositTerms } from './deposit.js';
import { isPaymentHistory } from './payment-history.js';
import { DECLINE_REASON_MAX } from './decline.js';
import {
	countdownLabel,
	daysUntil,
	eventDateLabel,
	formatMoney,
	guestCountLabel,
	submittedDateLabel
} from './presentation.js';

export const PROPOSAL_PERMISSIONS = [
	'commerce.financial-document.create',
	'commerce.deposit-requirement.manage',
	'fionas.financial-terms.manage'
] as const;
export function hasProposalPermissions(permissions: string[]): boolean {
	return PROPOSAL_PERMISSIONS.every((permission) => permissions.includes(permission));
}
/**
 * The booking progression shown in the progress strip. DECLINED is deliberately absent: it is a
 * terminal alternative to this path, never a step after CLOSED (see `progressSteps`).
 */
export const lifecycleStages = ['REQUESTED', 'QUOTED', 'BOOKED', 'SERVED', 'CLOSED'] as const;
export type ProgressStage = (typeof lifecycleStages)[number];
export type ProgressState = 'done' | 'current' | 'upcoming' | 'skipped';
/**
 * Each booking step's state for the strip. A DECLINED inquiry reached REQUESTED and then left the
 * path, so the later steps are `skipped` and no step is current.
 */
export function progressSteps(
	stage: InquiryStage
): { stage: ProgressStage; state: ProgressState }[] {
	if (stage === 'DECLINED')
		return lifecycleStages.map((step) => ({
			stage: step,
			state: step === 'REQUESTED' ? 'done' : 'skipped'
		}));
	const index = lifecycleStages.indexOf(stage);
	return lifecycleStages.map((step, i) => ({
		stage: step,
		state: i < index ? 'done' : i === index ? 'current' : 'upcoming'
	}));
}

/** Inquiry lifecycle decisions: serving, closing and declining. */
export const INQUIRY_MANAGE_PERMISSION = 'fionas.inquiries.manage';
export const FULFILLMENT_PERMISSION = INQUIRY_MANAGE_PERMISSION;
export type FulfillmentAction = 'markServed' | 'closeInquiry';
export function hasFulfillmentPermission(permissions: string[]): boolean {
	return permissions.includes(INQUIRY_MANAGE_PERMISSION);
}
/**
 * Declining needs only `fionas.inquiries.manage`, independent of the Quote permissions, and only a
 * coherent REQUESTED inquiry still on its unquoted canonical Estimate.
 */
export function canDeclineInquiry(data: StaffRequestResponse, permissions: string[]): boolean {
	return (
		permissions.includes(INQUIRY_MANAGE_PERMISSION) &&
		isCurrentStaffRequest(data, data.inquiry.id) &&
		data.inquiry.lifecycle.stage === 'REQUESTED' &&
		data.financial.stage === 'ESTIMATE' &&
		data.proposal == null &&
		data.depositRequirement.state === 'NONE'
	);
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

const lifecycleLabels: Record<InquiryStage, string> = {
	REQUESTED: 'Requested',
	QUOTED: 'Quoted',
	BOOKED: 'Booked',
	SERVED: 'Served',
	CLOSED: 'Closed',
	DECLINED: 'Declined'
};
export function lifecycleLabel(stage: InquiryStage): string {
	return lifecycleLabels[stage];
}
const lifecycleTones: Record<InquiryStage, 'inverse' | 'olive' | 'moss' | 'outline' | 'rust'> = {
	REQUESTED: 'inverse',
	QUOTED: 'olive',
	BOOKED: 'moss',
	SERVED: 'moss',
	CLOSED: 'outline',
	DECLINED: 'rust'
};
/** The badge tone that marks each lifecycle stage in the workspace header. */
export function lifecycleTone(stage: InquiryStage): (typeof lifecycleTones)[InquiryStage] {
	return lifecycleTones[stage];
}
function balanceSign(balance: string): 'zero' | 'negative' | 'positive' {
	return isExactZero(balance) ? 'zero' : balance.startsWith('-') ? 'negative' : 'positive';
}
/** The "Right now" headline; `today` is the business-timezone calendar date. */
export function requestSummary(data: CurrentStaffRequest, today: string): string {
	const stage = data.inquiry.lifecycle.stage;
	if (stage === 'REQUESTED') return 'Needs a quote';
	if (stage === 'QUOTED') {
		const deposit = data.depositRequirement;
		if (deposit.state === 'ACTIVE' && deposit.satisfied)
			return 'Quote issued — deposit requirement met';
		const firstName = data.inquiry.name.trim().split(/\s+/)[0];
		return firstName ? `Quote issued — waiting on ${firstName}’s deposit` : 'Quote issued';
	}
	if (stage === 'BOOKED') {
		const countdown = countdownLabel(daysUntil(data.inquiry.eventDate, today));
		return countdown
			? `On the calendar · scooping ${countdown}`
			: 'On the calendar · event date has passed';
	}
	if (stage === 'SERVED') {
		const sign = balanceSign(data.financial.reconciliation.balance);
		return sign === 'zero'
			? 'Served and paid in full'
			: sign === 'positive'
				? 'Served · balance due'
				: 'Served · balance needs review';
	}
	if (stage === 'DECLINED') return 'Request declined';
	return 'Event closed';
}
export function requestSummaryDescription(data: CurrentStaffRequest, today: string): string {
	const { inquiry, financial, proposal } = data;
	const stage = inquiry.lifecycle.stage;
	if (stage === 'REQUESTED') {
		const countdown = countdownLabel(daysUntil(inquiry.eventDate, today));
		return `Submitted ${submittedDateLabel(inquiry.createdAt)} · ${
			countdown ? `event is ${countdown}` : 'the event date has passed'
		}. Review the current Estimate below before issuing a quote.`;
	}
	if (stage === 'QUOTED')
		return `${proposal ? `Quote v${proposal.documentVersion} issued ${submittedDateLabel(proposal.issuedAt)}. ` : ''}The full approved deposit is required to hold the date and book this event.`;
	if (stage === 'CLOSED')
		return 'Service and payment are complete. Review the financial and payment history below.';
	if (stage === 'DECLINED')
		return 'No booking action is pending. The request and its original Estimate stay on file.';
	const balance = financial.reconciliation.balance;
	const sign = balanceSign(balance);
	if (stage === 'SERVED') {
		if (sign === 'zero') return 'The Invoice is settled and this event may be closed.';
		return sign === 'negative'
			? 'The Invoice balance must be exactly zero before closing this event.'
			: 'This event has been served. Record the remaining payment before closing it.';
	}
	const guests = data.servicePlan?.guestCount;
	const event = [
		eventDateLabel(inquiry.eventDate),
		guests
			? guestCountLabel(guests, false)
			: guestCountLabel(
					inquiry.requestedService.guestCount,
					inquiry.requestedService.guestCountIsMinimum
				)
	].join(' · ');
	return sign === 'positive'
		? `${event} · ${formatMoney(balance, financial.currency)} can be recorded any time, before or after the event.`
		: sign === 'zero'
			? `${event} · The Invoice is paid in full.`
			: `${event} · The Invoice balance is below zero. Review the payment history below.`;
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
		!inquiry.requestedService.items.every(isRequestedItem) ||
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
	// `declined` is present exactly when the stage is DECLINED (absent or null otherwise).
	const declined = inquiry.lifecycle.declined;
	if ((inquiry.lifecycle.stage === 'DECLINED') !== (declined != null)) return false;
	if (inquiry.lifecycle.stage === 'DECLINED')
		return (
			typeof declined === 'object' &&
			!!declined &&
			instant(declined.occurredAt) &&
			declined.principalKind === 'USER' &&
			typeof declined.principalId === 'string' &&
			!!declined.principalId &&
			typeof declined.reason === 'string' &&
			!!declined.reason &&
			declined.reason === declined.reason.trim() &&
			declined.reason.length <= DECLINE_REASON_MAX &&
			version(declined.documentVersion) &&
			// A decline belongs to exactly the canonical Estimate it reviewed; nothing progresses after.
			declined.documentVersion === financial.version &&
			financial.stage === 'ESTIMATE' &&
			proposal == null &&
			deposit.state === 'NONE' &&
			data.servicePlan == null &&
			inquiry.lifecycle.served == null &&
			inquiry.lifecycle.closed == null
		);
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
 * Operator diagnostics for a response `isCurrentStaffRequest` refused: field presence, types and
 * counts only, never a customer value, so it is safe to log.
 */
export function describeRejectedStaffRequest(data: StaffRequestResponse | null, inquiryId: string) {
	if (!data || typeof data !== 'object') return { response: typeof data };
	const money = (a: unknown) => typeof a === 'string' && /^-?\d+(\.\d+)?$/.test(a);
	const { inquiry, financial, proposal, depositRequirement: deposit } = data;
	const lines = Array.isArray(financial?.lines) ? financial.lines : [];
	const items = inquiry?.requestedService?.items;
	return {
		inquiryIdMatches: inquiry?.id === inquiryId,
		financialInquiryIdMatches: financial?.inquiryId === inquiryId,
		documentIdMatches: inquiry?.lifecycle?.documentId === financial?.id,
		stage: inquiry?.lifecycle?.stage ?? null,
		financialStage: financial?.stage ?? null,
		hasDeclined: inquiry?.lifecycle?.declined != null,
		guestCount: inquiry?.requestedService?.guestCount ?? null,
		guestCountIsMinimum: typeof inquiry?.requestedService?.guestCountIsMinimum,
		itemCount: Array.isArray(items) ? items.length : null,
		invalidItems: Array.isArray(items) ? items.filter((i) => !isRequestedItem(i)).length : null,
		lineCount: lines.length,
		linesMissingFields: lines.filter(
			(l) =>
				!l ||
				typeof l.id !== 'string' ||
				typeof l.description !== 'string' ||
				![l.unitPrice, l.subtotal, l.taxAmount, l.total].every(money) ||
				l.currency !== financial.currency
		).length,
		duplicateLineIds: new Set(lines.map((l) => l?.id)).size !== lines.length,
		currency: financial?.currency ?? null,
		totalsValid: [financial?.subtotal, financial?.taxAmount, financial?.total].every(money),
		version: financial?.version ?? null,
		reconciliationBalanceValid: money(financial?.reconciliation?.balance),
		reconciliationCurrencyMatches: financial?.reconciliation?.currency === financial?.currency,
		linesAuthoredBy: financial?.linesAuthoredBy
			? {
					principalKind: financial.linesAuthoredBy.principalKind,
					hasPrincipalId: !!financial.linesAuthoredBy.principalId,
					recordedAtValid: Number.isFinite(Date.parse(financial.linesAuthoredBy.recordedAt))
				}
			: null,
		paymentsIsArray: Array.isArray(data.payments),
		hasSuggestedDepositTerms: data.suggestedDepositTerms != null,
		suggestedDepositTermsValid: isDepositTerms(data.suggestedDepositTerms, financial?.currency),
		depositState: deposit?.state ?? null,
		depositDocumentIdMatches: deposit?.documentId === financial?.id,
		hasProposal: proposal != null,
		hasServicePlan: data.servicePlan != null
	};
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
		isServicePlanItems(plan.items) &&
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
