import { isServicePlanItems } from './service-selections.js';
import type { CurrentStaffRequest, InquiryProposalResponse } from './request-contract.js';
import type { ServicePlanResponse } from './quote-contract.js';

/*
 * Service approvals and Quote/Invoice publications are two independent, ordered sequences. A plan's
 * `documentVersion` can trail the latest financial version (a retained approval), equal the version it
 * reviewed (a service-only change), or be a clearing with no content at all. None of that is malformed;
 * only a self-contradicting response is. Currentness is never inferred from a financial version.
 */

const MAX_VERSION = 2_147_483_647;
const version = (value: unknown): value is number =>
	typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_VERSION;
const instant = (value: unknown): value is string =>
	typeof value === 'string' &&
	/^\d{4}-\d\d-\d\dT/.test(value) &&
	Number.isFinite(Date.parse(value));
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const optionalPositive = (value: unknown) => value == null || version(value);

type PlanScope = { documentId: string; latestVersion: number; lineIds: ReadonlySet<string> };

/** One approval, checked on its own. Content is required unless it is a deliberate clearing. */
export function isApprovedServicePlan(
	plan: unknown,
	scope: PlanScope
): plan is ServicePlanResponse {
	if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return false;
	const p = plan as ServicePlanResponse;
	if (
		p.documentId !== scope.documentId ||
		!version(p.documentVersion) ||
		p.documentVersion > scope.latestVersion ||
		!version(p.reviewedDocumentVersion) ||
		p.reviewedDocumentVersion > p.documentVersion ||
		!version(p.revision) ||
		!instant(p.approvedAt) ||
		!text(p.approvedBy) ||
		(p.cleared !== undefined && typeof p.cleared !== 'boolean') ||
		!Array.isArray(p.items) ||
		!Array.isArray(p.lineNotes)
	)
		return false;
	if (p.cleared)
		return (
			p.description == null &&
			p.guestCount == null &&
			p.durationMinutes == null &&
			p.items.length === 0 &&
			p.lineNotes.length === 0
		);
	return (
		text(p.description) &&
		p.description.length <= 2000 &&
		optionalPositive(p.guestCount) &&
		optionalPositive(p.durationMinutes) &&
		isServicePlanItems(p.items) &&
		new Set(p.lineNotes.map((n) => n?.lineItemId)).size === p.lineNotes.length &&
		p.lineNotes.every(
			(n) =>
				!!n &&
				text(n.lineItemId) &&
				typeof n.note === 'string' &&
				// Notes of the approval snapshot that is the current one must name its current lines.
				(p.documentVersion !== scope.latestVersion || scope.lineIds.has(n.lineItemId))
		)
	);
}

function isProposal(value: unknown, data: CurrentStaffRequest): value is InquiryProposalResponse {
	if (!value || typeof value !== 'object') return false;
	const p = value as InquiryProposalResponse;
	return (
		text(p.id) &&
		p.inquiryId === data.inquiry.id &&
		p.documentId === data.financial.id &&
		version(p.documentVersion) &&
		p.documentVersion <= data.financial.version &&
		version(p.depositRequirementRevision) &&
		instant(p.issuedAt) &&
		text(p.issuedBy) &&
		text(p.issuanceKind) &&
		(p.servicePlanRevision == null || version(p.servicePlanRevision))
	);
}

const sameApproval = (
	a: ServicePlanResponse | null | undefined,
	b: ServicePlanResponse | null | undefined
) =>
	(a ?? null) === (b ?? null) ||
	(!!a &&
		!!b &&
		a.revision === b.revision &&
		a.documentVersion === b.documentVersion &&
		a.approvedAt === b.approvedAt &&
		!!a.cleared === !!b.cleared);

/**
 * Whether the projection's service state is consistent with itself: each approval valid, both
 * histories ordered, the current, bound and accepted plans members of that history, and every
 * proposal's `servicePlanRevision` joined to a real approval.
 */
export function isCoherentServicePlanState(data: CurrentStaffRequest): boolean {
	const { inquiry, financial, proposal } = data;
	const history = data.servicePlanHistory;
	const proposals = data.proposalHistory;
	if (!Array.isArray(history) || !Array.isArray(proposals)) return false;
	const scope: PlanScope = {
		documentId: financial.id,
		latestVersion: financial.version,
		lineIds: new Set(financial.lines.map((l) => l.id))
	};
	const plans = [data.servicePlan, data.effectiveServicePlan, data.acceptedServicePlan];
	if (
		!history.every((p) => isApprovedServicePlan(p, scope)) ||
		!plans.every((p) => p == null || isApprovedServicePlan(p, scope))
	)
		return false;
	for (let i = 1; i < history.length; i++)
		if (
			history[i].revision <= history[i - 1].revision ||
			Date.parse(history[i].approvedAt) < Date.parse(history[i - 1].approvedAt)
		)
			return false;
	const byRevision = new Map(history.map((p) => [p.revision, p]));
	if (!sameApproval(data.effectiveServicePlan ?? null, history.at(-1) ?? null)) return false;
	for (const plan of plans)
		if (plan && !sameApproval(plan, byRevision.get(plan.revision))) return false;

	const stage = inquiry.lifecycle.stage;
	if (stage === 'REQUESTED' || stage === 'DECLINED')
		return !proposal && !proposals.length && !history.length && plans.every((p) => p == null);
	if (!proposal || !proposals.length || proposals.at(-1)!.id !== proposal.id) return false;
	if (!proposals.every((p) => isProposal(p, data))) return false;
	if (new Set(proposals.map((p) => p.id)).size !== proposals.length) return false;
	for (let i = 1; i < proposals.length; i++)
		if (
			proposals[i].documentVersion < proposals[i - 1].documentVersion ||
			proposals[i].depositRequirementRevision < proposals[i - 1].depositRequirementRevision ||
			(proposals[i].servicePlanRevision ?? 0) < (proposals[i - 1].servicePlanRevision ?? 0) ||
			Date.parse(proposals[i].issuedAt) < Date.parse(proposals[i - 1].issuedAt)
		)
			return false;
	if (
		proposals.some((p) => p.servicePlanRevision != null && !byRevision.has(p.servicePlanRevision))
	)
		return false;
	// The bound plan is exactly the one the latest publication names; none when it names none.
	if ((proposal.servicePlanRevision ?? null) !== (data.servicePlan?.revision ?? null)) return false;
	const booked = stage !== 'QUOTED';
	if (!booked)
		// Before booking there is no amendment: the fulfillment plan is the proposal's.
		return (
			data.acceptedServicePlan == null && sameApproval(data.effectiveServicePlan, data.servicePlan)
		);
	return (
		sameApproval(data.acceptedServicePlan, data.servicePlan) &&
		(data.effectiveServicePlan?.revision ?? 0) >= (data.servicePlan?.revision ?? 0)
	);
}

/** The three distinct states of a service commitment. Never infer one from another. */
export type ServiceCommitment =
	| { state: 'NEVER'; plan: null }
	| { state: 'CLEARED'; plan: ServicePlanResponse }
	| { state: 'APPROVED'; plan: ServicePlanResponse };
export function serviceCommitment(
	data: Pick<CurrentStaffRequest, 'effectiveServicePlan'>
): ServiceCommitment {
	const plan = data.effectiveServicePlan ?? null;
	return !plan
		? { state: 'NEVER', plan: null }
		: plan.cleared
			? { state: 'CLEARED', plan }
			: { state: 'APPROVED', plan };
}

/**
 * Which financial document an approval was made against. After booking the accepted Quote is the
 * last proposal's version; any later version is an Invoice.
 */
export function approvalSource(
	plan: ServicePlanResponse,
	data: Pick<CurrentStaffRequest, 'proposal' | 'inquiry'>
): 'Quote' | 'Invoice' {
	const booked =
		data.inquiry.lifecycle.stage !== 'QUOTED' && data.inquiry.lifecycle.stage !== 'REQUESTED';
	return booked && data.proposal && plan.documentVersion > data.proposal.documentVersion
		? 'Invoice'
		: 'Quote';
}
