import { describe, expect, it } from 'vitest';
import { isCurrentStaffRequest } from './request-workspace.js';
import { approvalSource, isApprovedServicePlan, serviceCommitment } from './service-plan.js';
import { mayaId, requestFixtures } from '../../e2e/request-fixture.mjs';
import { revisionFixture, type RevisionState } from '../../e2e/revision-fixture.mjs';

const valid = (state: RevisionState) => {
	const data = revisionFixture(state);
	return { data, ok: isCurrentStaffRequest(data, data.inquiry.id) };
};

describe('every legitimate revision state is a coherent projection', () => {
	it.each<RevisionState>([
		'unquoted',
		'quoted',
		'quote-financial-revision',
		'quote-deposit-revision',
		'quote-service-revision',
		'booked',
		'booked-additional',
		'invoice-financial-amendment',
		'invoice-service-amendment',
		'served',
		'closed',
		'declined',
		'plan-cleared',
		'historical-plan',
		'overpaid'
	])('accepts %s', (state) => {
		expect(valid(state).ok).toBe(true);
	});
});

describe('current, retained and cleared approvals', () => {
	it('lets a retained plan reference an older financial snapshot', () => {
		const { data } = valid('historical-plan');
		// The Quote was repriced to v3 while the plan stayed approved against v2.
		expect(data.financial.version).toBe(3);
		expect(data.effectiveServicePlan?.documentVersion).toBe(2);
		expect(data.proposal?.servicePlanRevision).toBe(1);
	});
	it('lets a service-only revision keep the financial version and add an approval', () => {
		const { data } = valid('quote-service-revision');
		expect(data.financial.version).toBe(2);
		expect(data.servicePlanHistory.map((p) => p.revision)).toEqual([1, 2]);
		expect(data.effectiveServicePlan).toMatchObject({
			revision: 2,
			documentVersion: 2,
			reviewedDocumentVersion: 2
		});
		expect(data.proposalHistory).toHaveLength(2);
		expect(data.proposalHistory[1].documentVersion).toBe(data.proposalHistory[0].documentVersion);
	});
	it('keeps the accepted plan apart from the effective plan after an amendment', () => {
		const { data } = valid('invoice-service-amendment');
		expect(data.acceptedServicePlan?.revision).toBe(1);
		expect(data.effectiveServicePlan?.revision).toBe(2);
		expect(data.servicePlan?.revision).toBe(1);
		expect(data.proposalHistory).toHaveLength(1);
		expect(approvalSource(data.effectiveServicePlan!, data)).toBe('Invoice');
		expect(approvalSource(data.acceptedServicePlan!, data)).toBe('Quote');
	});
	it('treats an intentional clearing as its own state, not as never approved', () => {
		const cleared = valid('plan-cleared').data;
		expect(cleared.effectiveServicePlan).toMatchObject({ cleared: true, revision: 2, items: [] });
		expect(cleared.effectiveServicePlan?.description).toBeUndefined();
		expect(serviceCommitment(cleared).state).toBe('CLEARED');
		// The accepted plan is still the one the deposit accepted.
		expect(cleared.acceptedServicePlan?.cleared).toBeFalsy();
		expect(serviceCommitment(requestFixtures()[mayaId]).state).toBe('NEVER');
		expect(serviceCommitment(valid('booked').data).state).toBe('APPROVED');
	});
});

describe('approval structure', () => {
	const scope = (data: ReturnType<typeof revisionFixture>) => ({
		documentId: data.financial.id,
		latestVersion: data.financial.version,
		lineIds: new Set(data.financial.lines.map((l) => l.id))
	});
	const plan = () => {
		const data = revisionFixture('booked');
		return { data, plan: structuredClone(data.effectiveServicePlan!) };
	};
	it.each([
		['a non-positive revision', (p: Record<string, unknown>) => (p.revision = 0)],
		['a fractional revision', (p: Record<string, unknown>) => (p.revision = 1.5)],
		['a missing revision', (p: Record<string, unknown>) => delete p.revision],
		['no approver', (p: Record<string, unknown>) => (p.approvedBy = '')],
		['a bad approval time', (p: Record<string, unknown>) => (p.approvedAt = 'later')],
		['another document', (p: Record<string, unknown>) => (p.documentId = 'other')],
		['a version beyond the latest', (p: Record<string, unknown>) => (p.documentVersion = 99)],
		[
			'a review newer than its snapshot',
			(p: Record<string, unknown>) => (p.reviewedDocumentVersion = 99)
		],
		['content missing when not cleared', (p: Record<string, unknown>) => delete p.description],
		['a non-boolean cleared', (p: Record<string, unknown>) => (p.cleared = 'yes')]
	])('refuses %s', (_name, corrupt) => {
		const { data, plan: p } = plan();
		corrupt(p as unknown as Record<string, unknown>);
		expect(isApprovedServicePlan(p, scope(data))).toBe(false);
	});
	it('refuses a clearing that still carries content, and a duplicate note target', () => {
		const { data, plan: p } = plan();
		expect(isApprovedServicePlan({ ...p, cleared: true }, scope(data))).toBe(false);
		const note = p.lineNotes[0];
		expect(isApprovedServicePlan({ ...p, lineNotes: [note, note] }, scope(data))).toBe(false);
	});
	it('accepts a clearing with only references and provenance', () => {
		const { data, plan: p } = plan();
		const clearing = {
			documentId: p.documentId,
			documentVersion: p.documentVersion,
			reviewedDocumentVersion: p.reviewedDocumentVersion,
			items: [],
			lineNotes: [],
			approvedAt: p.approvedAt,
			approvedBy: p.approvedBy,
			revision: 2,
			cleared: true
		};
		expect(isApprovedServicePlan(clearing, scope(data))).toBe(true);
	});
	it('does not require a historical note to name a current line', () => {
		const data = revisionFixture('historical-plan');
		// The retained approval references v2; its note still names a ledger line that exists.
		const retained = data.effectiveServicePlan!;
		expect(retained.documentVersion).toBeLessThan(data.financial.version);
		expect(isApprovedServicePlan(retained, scope(data))).toBe(true);
	});
});

describe('histories join and stay ordered', () => {
	const bad = (state: RevisionState, corrupt: (d: ReturnType<typeof revisionFixture>) => void) => {
		const data = revisionFixture(state);
		corrupt(data);
		return isCurrentStaffRequest(data, data.inquiry.id);
	};
	it('refuses a missing history rather than inventing an empty one', () => {
		expect(bad('booked', (d) => delete (d as { proposalHistory?: unknown }).proposalHistory)).toBe(
			false
		);
		expect(
			bad('booked', (d) => delete (d as { servicePlanHistory?: unknown }).servicePlanHistory)
		).toBe(false);
	});
	it('refuses unordered or duplicated approvals', () => {
		expect(bad('quote-service-revision', (d) => d.servicePlanHistory.reverse())).toBe(false);
		expect(bad('quote-service-revision', (d) => (d.servicePlanHistory[1].revision = 1))).toBe(
			false
		);
	});
	it('refuses a proposal naming an approval that is not in the history', () => {
		expect(bad('booked', (d) => (d.proposalHistory[0].servicePlanRevision = 7))).toBe(false);
	});
	it('requires the last publication to be the current proposal', () => {
		expect(bad('quote-deposit-revision', (d) => (d.proposalHistory[1].id = 'someone-else'))).toBe(
			false
		);
		expect(bad('quote-deposit-revision', (d) => d.proposalHistory.pop())).toBe(false);
	});
	it('refuses an effective plan that is not the latest approval', () => {
		expect(bad('invoice-service-amendment', (d) => (d.effectiveServicePlan = d.servicePlan))).toBe(
			false
		);
		expect(bad('booked', (d) => (d.effectiveServicePlan = null))).toBe(false);
	});
	it('ties the accepted plan to the proposal, and only after booking', () => {
		expect(bad('booked', (d) => (d.acceptedServicePlan = null))).toBe(false);
		expect(bad('quoted', (d) => (d.acceptedServicePlan = d.servicePlan))).toBe(false);
	});
	it('refuses a history for a request that never had a Quote', () => {
		expect(
			bad('unquoted', (d) => d.servicePlanHistory.push(revisionFixture('booked').servicePlan!))
		).toBe(false);
	});
	it('refuses publications that go back in time', () => {
		expect(
			bad('quote-deposit-revision', (d) => (d.proposalHistory[1].depositRequirementRevision = 0))
		).toBe(false);
	});
});
