import { describe, expect, it } from 'vitest';
import {
	canIssueQuote,
	financialStageLabel,
	isCurrentStaffRequest,
	lifecycleLabel,
	lifecycleStages,
	PROPOSAL_PERMISSIONS,
	quoteErrorMessage,
	requestErrorKind,
	requestSummary
} from './request-workspace.js';
import {
	businessDate,
	countdownLabel,
	daysUntil,
	eventDateLabel,
	eventTypeLabel,
	guestCountLabel,
	submittedDateLabel
} from './presentation.js';
import { mayaId, requestFixtures } from '../../e2e/request-fixture.mjs';

function quotedWithPlan() {
	const data = requestFixtures()['00000000-0000-0000-0000-000000000001'];
	data.servicePlan = {
		documentId: data.financial.id,
		documentVersion: data.proposal!.documentVersion,
		reviewedDocumentVersion: 1,
		description: 'Bespoke service',
		items: [{ label: 'Churros' }],
		lineNotes: [{ lineItemId: data.financial.lines[0].id, note: 'Negotiated' }],
		approvedAt: '2026-07-16T19:01:00Z',
		approvedBy: '00000000-0000-0000-0000-000000000001'
	};
	return data;
}

describe('approved service plans', () => {
	it('accepts a plan that matches the current Quote line for line, and its absence', () => {
		const data = quotedWithPlan();
		expect(isCurrentStaffRequest(data, data.inquiry.id)).toBe(true);
		delete data.servicePlan;
		expect(isCurrentStaffRequest(data, data.inquiry.id)).toBe(true);
	});
	it('fails closed on a plan for another document, version or line set', () => {
		for (const corrupt of [
			(data: ReturnType<typeof quotedWithPlan>) => (data.servicePlan!.documentId = 'other'),
			(data: ReturnType<typeof quotedWithPlan>) => data.servicePlan!.documentVersion++,
			(data: ReturnType<typeof quotedWithPlan>) => (data.servicePlan!.description = ''),
			(data: ReturnType<typeof quotedWithPlan>) =>
				(data.servicePlan!.lineNotes[0].lineItemId = '99999999-0000-0000-0000-000000000000')
		]) {
			const data = quotedWithPlan();
			corrupt(data);
			expect(isCurrentStaffRequest(data, data.inquiry.id)).toBe(false);
		}
		const requested = requestFixtures()[mayaId];
		requested.servicePlan = quotedWithPlan().servicePlan;
		expect(isCurrentStaffRequest(requested, mayaId)).toBe(false);
	});
	it('keeps the accepted plan once a later Invoice version replaces its lines', () => {
		const data = quotedWithPlan();
		data.inquiry.lifecycle.stage = 'BOOKED';
		data.financial.stage = 'INVOICE';
		data.financial.version = 3;
		data.financial.lines = data.financial.lines.map((l) => ({ ...l, id: `9${l.id.substring(1)}` }));
		expect(isCurrentStaffRequest(data, data.inquiry.id)).toBe(true);
	});
});

describe('line authorship', () => {
	const recordedAt = '2026-07-16T19:00:00Z';
	const accepts = (authored: object | null | undefined) => {
		const data = requestFixtures()[mayaId];
		(data.financial as { linesAuthoredBy: unknown }).linesAuthoredBy = authored;
		return isCurrentStaffRequest(data, mayaId);
	};
	it('accepts a principal, with or without originKind', () => {
		const principal = { principalKind: 'SERVICE', principalId: 'service-1', recordedAt };
		expect(accepts(principal)).toBe(true);
		expect(accepts({ ...principal, originKind: 'PRINCIPAL', component: null })).toBe(true);
		expect(accepts({ ...principal, principalKind: 'USER' })).toBe(true);
	});
	it('accepts an internal component, as inquiry intake authors the first Estimate', () => {
		const internal = { originKind: 'INTERNAL', component: 'inquiry-intake', recordedAt };
		expect(accepts(internal)).toBe(true);
		expect(accepts({ ...internal, principalKind: null, principalId: null })).toBe(true);
	});
	it('fails closed on a missing, mixed or incomplete origin', () => {
		for (const bad of [
			null,
			undefined,
			{ recordedAt },
			{ originKind: 'INTERNAL', recordedAt },
			{ originKind: 'INTERNAL', component: ' ', recordedAt },
			{
				originKind: 'INTERNAL',
				component: 'inquiry-intake',
				principalKind: 'USER',
				principalId: 'u',
				recordedAt
			},
			{ originKind: 'PRINCIPAL', recordedAt },
			{
				originKind: 'PRINCIPAL',
				principalKind: 'USER',
				principalId: 'u',
				component: 'x',
				recordedAt
			},
			{ originKind: 'OTHER', principalKind: 'USER', principalId: 'u', recordedAt },
			{ principalKind: 'ROBOT', principalId: 'u', recordedAt },
			{ principalKind: 'USER', principalId: '', recordedAt },
			{ originKind: 'INTERNAL', component: 'inquiry-intake', recordedAt: 'not a date' }
		])
			expect(accepts(bad)).toBe(false);
	});
});

describe('request workspace presentation', () => {
	it('requires the permission intersection', () => {
		const data = requestFixtures()[mayaId];
		for (const permissions of [[], [PROPOSAL_PERMISSIONS[0]], [PROPOSAL_PERMISSIONS[1]]])
			expect(canIssueQuote(data, permissions)).toBe(false);
		expect(canIssueQuote(data, [...PROPOSAL_PERMISSIONS])).toBe(true);
	});
	it('accepts exact quoted and historical Invoice pairs including an unsatisfied booking deposit', () => {
		const all = requestFixtures();
		for (const request of Object.values(all))
			expect(isCurrentStaffRequest(request, request.inquiry.id)).toBe(true);
		const revised = all['00000000-0000-0000-0000-000000000001'];
		for (const kind of ['QUOTE_REVISED', 'DEPOSIT_REVISED']) {
			revised.proposal!.issuanceKind = kind;
			expect(isCurrentStaffRequest(revised, revised.inquiry.id)).toBe(true);
		}
		const booked = all['00000000-0000-0000-0000-000000000001'];
		booked.inquiry.lifecycle.stage = 'BOOKED';
		booked.financial.stage = 'INVOICE';
		booked.financial.version = 3;
		if (booked.depositRequirement.state === 'ACTIVE') booked.depositRequirement.satisfied = false;
		expect(isCurrentStaffRequest(booked, booked.inquiry.id)).toBe(true);
		expect(canIssueQuote(booked, [...PROPOSAL_PERMISSIONS])).toBe(false);
	});
	it('rejects partial or contradictory proposal/deposit state', () => {
		const quoted = () => requestFixtures()['00000000-0000-0000-0000-000000000001'];
		const mutations = [
			(data: ReturnType<typeof quoted>) => {
				data.proposal!.inquiryId = 'other';
			},
			(data: ReturnType<typeof quoted>) => {
				data.proposal!.documentId = 'other';
			},
			(data: ReturnType<typeof quoted>) => {
				data.proposal!.documentVersion++;
			},
			(data: ReturnType<typeof quoted>) => {
				data.proposal = null;
			},
			(data: ReturnType<typeof quoted>) => {
				if (data.depositRequirement.state === 'ACTIVE') data.depositRequirement.revision++;
			},
			(data: ReturnType<typeof quoted>) => {
				if (data.depositRequirement.state === 'ACTIVE')
					data.depositRequirement.approvalDocumentVersion++;
			},
			(data: ReturnType<typeof quoted>) => {
				if (data.depositRequirement.state === 'ACTIVE')
					data.depositRequirement.requiredAmount.currency = 'CAD';
			},
			(data: ReturnType<typeof quoted>) => {
				data.depositRequirement.documentId = 'other';
			}
		];
		for (const mutate of mutations) {
			const data = quoted();
			mutate(data);
			expect(isCurrentStaffRequest(data, data.inquiry.id)).toBe(false);
		}
		const requested = requestFixtures()[mayaId];
		for (const missing of ['suggestedDepositTerms', 'depositRequirement'] as const) {
			const partial = { ...requested };
			Reflect.deleteProperty(partial, missing);
			expect(isCurrentStaffRequest(partial, mayaId)).toBe(false);
		}
	});
	it('presents lifecycle from the inquiry, independently of the financial facts', () => {
		const data = requestFixtures()[mayaId];
		const today = '2026-07-01';
		expect(requestSummary(data, today)).toBe('Needs a quote');
		data.financial.stage = 'QUOTE';
		data.financial.reconciliation.balance = '0.00';
		expect(requestSummary(data, today)).toBe('Needs a quote');
		data.inquiry.lifecycle.stage = 'QUOTED';
		data.financial.stage = 'ESTIMATE';
		expect(requestSummary(data, today)).toMatch(/^Quote issued/);
		expect(canIssueQuote(data, [...PROPOSAL_PERMISSIONS])).toBe(false);
		expect(lifecycleStages.map(lifecycleLabel)).toEqual([
			'Requested',
			'Quoted',
			'Booked',
			'Served',
			'Closed'
		]);
		expect(financialStageLabel('INVOICE')).toBe('Invoice');
		expect(financialStageLabel('FUTURE_STAGE')).toBe('Financial document');
	});
	it('words the Right now headline from stage, event date and exact balance', () => {
		const data = requestFixtures()['00000000-0000-0000-0000-000000000001'];
		const deposit = data.depositRequirement;
		if (deposit.state !== 'ACTIVE') throw new Error('expected a quoted fixture');
		data.inquiry.name = 'Maya Torres';
		data.inquiry.eventDate = '2026-07-25';
		data.inquiry.lifecycle.stage = 'QUOTED';
		deposit.satisfied = false;
		expect(requestSummary(data, '2026-07-01')).toBe('Quote issued — waiting on Maya’s deposit');
		deposit.satisfied = true;
		expect(requestSummary(data, '2026-07-01')).toBe('Quote issued — deposit requirement met');
		data.inquiry.lifecycle.stage = 'BOOKED';
		expect(requestSummary(data, '2026-07-01')).toBe('On the calendar · scooping in 24 days');
		expect(requestSummary(data, '2026-07-24')).toBe('On the calendar · scooping tomorrow');
		expect(requestSummary(data, '2026-07-25')).toBe('On the calendar · scooping today');
		expect(requestSummary(data, '2026-07-26')).toBe('On the calendar · event date has passed');
		data.inquiry.lifecycle.stage = 'SERVED';
		for (const [balance, headline] of [
			['0.000', 'Served and paid in full'],
			['0.01', 'Served · balance due'],
			['-5.00', 'Served · balance needs review']
		]) {
			data.financial.reconciliation.balance = balance;
			expect(requestSummary(data, '2026-07-26')).toBe(headline);
		}
		data.inquiry.lifecycle.stage = 'CLOSED';
		expect(requestSummary(data, '2026-07-26')).toBe('Event closed');
	});
	it('keeps day counts on business-calendar dates', () => {
		expect(daysUntil('2026-11-14', '2026-10-20')).toBe(25);
		expect(daysUntil('2026-03-09', '2026-03-08')).toBe(1);
		expect(countdownLabel(-1)).toBeNull();
		// 06:30 UTC is still the previous evening in Pacific time.
		expect(businessDate(new Date('2026-10-21T06:30:00Z'))).toBe('2026-10-20');
	});
	it('requires both eligible state and the permission, regardless of role', () => {
		const data = requestFixtures()[mayaId];
		expect(canIssueQuote(data, [])).toBe(false);
		expect(canIssueQuote(data, [...PROPOSAL_PERMISSIONS])).toBe(true);
		data.financial.stage = 'QUOTE';
		expect(canIssueQuote(data, [...PROPOSAL_PERMISSIONS])).toBe(false);
	});
	it('rejects absent reconciliation, partial data and inconsistent ownership', () => {
		const data = requestFixtures()[mayaId];
		expect(isCurrentStaffRequest(data, mayaId)).toBe(true);
		expect(isCurrentStaffRequest(null, mayaId)).toBe(false);
		expect(
			isCurrentStaffRequest(
				{ ...data, financial: { ...data.financial, reconciliation: undefined } },
				mayaId
			)
		).toBe(false);
		expect(
			isCurrentStaffRequest(
				{ ...data, financial: { ...data.financial, inquiryId: 'another-inquiry' } },
				mayaId
			)
		).toBe(false);
		expect(
			isCurrentStaffRequest(
				{ ...data, financial: { ...data.financial, id: 'another-document' } },
				mayaId
			)
		).toBe(false);
	});
	it('formats calendar dates consistently at month/year boundaries and leap days', () => {
		expect(eventDateLabel('2026-07-25')).toBe('Saturday, July 25');
		expect(eventDateLabel('2027-01-01')).toBe('Friday, January 1');
		expect(eventDateLabel('2028-02-29')).toBe('Tuesday, February 29');
		expect(submittedDateLabel('2026-07-15T03:00:00Z')).toBe('Jul 14');
		expect(eventTypeLabel('CORPORATE')).toBe('Corporate event');
	});
	it('formats minimum guests without repricing', () => {
		expect(guestCountLabel(40, false)).toBe('40 guests');
		expect(guestCountLabel(120, true)).toBe('120+ guests (minimum)');
	});
	it('uses safe status-based errors and treats mutation unavailability as ambiguous', () => {
		expect(requestErrorKind(404)).toBe('not-found');
		expect(requestErrorKind(403)).toBe('forbidden');
		expect(requestErrorKind(500)).toBe('unavailable');
		expect(quoteErrorMessage(409)).toContain('Reload to review');
		expect(quoteErrorMessage(500)).toContain('couldn’t confirm whether');
	});
});
it('rejects legacy and malformed selection responses while accepting custom and duplicate selections', () => {
	for (const items of [
		['legacy'],
		[{ label: '' }],
		[{ label: 'x', group: 42 }],
		[{ label: 'x', key: 'x'.repeat(121) }],
		Array.from({ length: 51 }, () => ({ label: 'x' }))
	]) {
		const data = quotedWithPlan();
		Object.assign(data.servicePlan!, { items });
		expect(isCurrentStaffRequest(data, data.inquiry.id)).toBe(false);
	}
	const data = quotedWithPlan();
	data.servicePlan!.items = [
		{ label: 'Custom', group: null, key: null },
		{ label: 'Custom', group: null, key: null }
	];
	expect(isCurrentStaffRequest(data, data.inquiry.id)).toBe(true);
});
