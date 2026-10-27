import { isDepositTerms } from './deposit.js';
import { isCurrentStaffRequest } from './request-workspace.js';
import { approvalSource } from './service-plan.js';
import type {
	CurrentStaffRequest,
	DepositRequirementHistoryResponse,
	FinancialDocumentHistoryResponse,
	InquiryProposalResponse
} from './request-contract.js';
import type { ServicePlanResponse } from './quote-contract.js';

/*
 * Revision history composes three independent facts: Quote/deposit publications (`proposalHistory`),
 * service approvals (`servicePlanHistory`, its own revision numbers) and, on request, the immutable
 * financial snapshots and deposit revisions. They are never merged into a single counter: a
 * service-only change advances only the approval sequence, a financial change only the document's.
 */

const money = (v: unknown) => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);
const positive = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0;
const instant = (v: unknown) =>
	typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));

/** Optional detail: a malformed history is "unavailable", never an empty or partial timeline. */
export function isFinancialDocumentHistory(
	value: unknown,
	scope: { documentId: string; inquiryId: string; latestVersion: number }
): value is FinancialDocumentHistoryResponse {
	if (!value || typeof value !== 'object') return false;
	const h = value as FinancialDocumentHistoryResponse;
	if (h.id !== scope.documentId || h.inquiryId !== scope.inquiryId || !Array.isArray(h.versions))
		return false;
	if (!h.versions.length) return false;
	let previous = 0;
	for (const v of h.versions) {
		if (
			!v ||
			typeof v !== 'object' ||
			v.id !== scope.documentId ||
			!positive(v.version) ||
			v.version <= previous ||
			typeof v.stage !== 'string' ||
			!instant(v.createdAt) ||
			!Array.isArray(v.lines) ||
			!money(v.total) ||
			!money(v.subtotal) ||
			!money(v.taxAmount) ||
			typeof v.currency !== 'string' ||
			!v.lines.every(
				(l) =>
					!!l && typeof l.id === 'string' && typeof l.description === 'string' && money(l.total)
			)
		)
			return false;
		previous = v.version;
	}
	return previous === scope.latestVersion;
}

export function isDepositRequirementHistory(
	value: unknown,
	scope: { documentId: string; currency: string }
): value is DepositRequirementHistoryResponse {
	if (!value || typeof value !== 'object') return false;
	const h = value as DepositRequirementHistoryResponse;
	if (!Array.isArray(h.revisions)) return false;
	let previous = 0;
	for (const r of h.revisions) {
		if (
			!r ||
			typeof r !== 'object' ||
			r.documentId !== scope.documentId ||
			!positive(r.revision) ||
			r.revision <= previous ||
			!instant(r.createdAt)
		)
			return false;
		if (r.state === 'ACTIVE') {
			if (
				!isDepositTerms(r.terms, scope.currency) ||
				!money(r.requiredAmount?.amount) ||
				r.requiredAmount.currency !== scope.currency ||
				!positive(r.approvalDocumentVersion)
			)
				return false;
		} else if (r.state !== 'WITHDRAWN' || !positive(r.previousRevision)) return false;
		previous = r.revision;
	}
	return true;
}

export type PublicationEntry = {
	proposal: InquiryProposalResponse;
	/** What changed against the previous publication, from facts alone. */
	changes: string[];
	kind: string;
	/** The Quote that became the Invoice is "accepted"; the newest otherwise "current". */
	status: 'Current' | 'Accepted' | 'Superseded';
	plan: ServicePlanResponse | null;
};
const kindLabels: Record<string, string> = {
	INITIAL: 'Quote issued',
	QUOTE_REVISED: 'Quote revised',
	DEPOSIT_REVISED: 'Deposit terms changed'
};
/** Newest first. */
export function publicationEntries(data: CurrentStaffRequest): PublicationEntry[] {
	const plans = new Map(data.servicePlanHistory.map((p) => [p.revision, p]));
	const booked = data.financial.stage === 'INVOICE';
	return data.proposalHistory
		.map((proposal, i, all): PublicationEntry => {
			const before = all[i - 1];
			const changes = !before
				? []
				: [
						...(proposal.documentVersion !== before.documentVersion ? ['Pricing'] : []),
						...(proposal.depositRequirementRevision !== before.depositRequirementRevision
							? ['Deposit terms']
							: []),
						...((proposal.servicePlanRevision ?? null) !== (before.servicePlanRevision ?? null)
							? ['Service plan']
							: [])
					];
			return {
				proposal,
				changes,
				kind: kindLabels[proposal.issuanceKind] ?? 'Quote published',
				status: i < all.length - 1 ? 'Superseded' : booked ? 'Accepted' : 'Current',
				plan: proposal.servicePlanRevision
					? (plans.get(proposal.servicePlanRevision) ?? null)
					: null
			};
		})
		.reverse();
}

export type ApprovalEntry = {
	plan: ServicePlanResponse;
	label: string;
	source: 'Quote' | 'Invoice';
	current: boolean;
	accepted: boolean;
};
/** Newest first. A clearing is its own deliberate entry, not an absence. */
export function approvalEntries(data: CurrentStaffRequest): ApprovalEntry[] {
	return data.servicePlanHistory
		.map((plan) => ({
			plan,
			label: plan.cleared
				? 'Service plan removed'
				: plan.revision === 1
					? 'Service plan approved'
					: 'Service plan updated',
			source: approvalSource(plan, data),
			current: plan.revision === data.effectiveServicePlan?.revision,
			accepted: plan.revision === data.acceptedServicePlan?.revision
		}))
		.reverse();
}

/** Whether the booking has anything to show beyond its current document. */
export function hasRevisionHistory(data: CurrentStaffRequest): boolean {
	return (
		isCurrentStaffRequest(data, data.inquiry.id) &&
		(data.proposalHistory.length > 0 || data.servicePlanHistory.length > 0)
	);
}
