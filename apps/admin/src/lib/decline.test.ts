import { describe, expect, it } from 'vitest';
import {
	canCloseInquiry,
	canDeclineInquiry,
	canIssueQuote,
	canMarkServed,
	INQUIRY_MANAGE_PERMISSION,
	isCurrentStaffRequest,
	lifecycleLabel,
	lifecycleTone,
	progressSteps,
	PROPOSAL_PERMISSIONS,
	requestSummary,
	requestSummaryDescription
} from './request-workspace.js';
import {
	DECLINE_REASON_MAX,
	declineErrorMessage,
	declineReason,
	declineReasonMessage,
	declineReasonProblem,
	readDeclineForm
} from './decline.js';
import { canRecordDeposit, canRecordInvoicePayment, PAYMENT_PERMISSION } from './payments.js';
import { declinedFixture, mayaId, requestFixtures } from '../../e2e/request-fixture.mjs';

const everything = [...PROPOSAL_PERMISSIONS, INQUIRY_MANAGE_PERMISSION, PAYMENT_PERMISSION];

function form(entries: [string, string][]) {
	const data = new FormData();
	for (const [key, value] of entries) data.append(key, value);
	return data;
}

describe('decline eligibility', () => {
	it('needs only fionas.inquiries.manage, independent of the Quote permissions', () => {
		const requested = requestFixtures()[mayaId];
		expect(canDeclineInquiry(requested, [INQUIRY_MANAGE_PERMISSION])).toBe(true);
		expect(canIssueQuote(requested, [INQUIRY_MANAGE_PERMISSION])).toBe(false);
		expect(canDeclineInquiry(requested, [...PROPOSAL_PERMISSIONS])).toBe(false);
		expect(canIssueQuote(requested, [...PROPOSAL_PERMISSIONS])).toBe(true);
		expect(canDeclineInquiry(requested, [PAYMENT_PERMISSION])).toBe(false);
	});
	it('is never offered once quoted, booked, served, closed or declined', () => {
		const quoted = requestFixtures()['00000000-0000-0000-0000-000000000001'];
		expect(quoted.inquiry.lifecycle.stage).toBe('QUOTED');
		expect(canDeclineInquiry(quoted, everything)).toBe(false);
		for (const stage of ['BOOKED', 'SERVED', 'CLOSED'] as const) {
			const later = structuredClone(quoted);
			later.inquiry.lifecycle.stage = stage;
			later.financial.stage = 'INVOICE';
			expect(canDeclineInquiry(later, everything)).toBe(false);
		}
		expect(canDeclineInquiry(declinedFixture(), everything)).toBe(false);
	});
	it('refuses an incoherent projection rather than trusting its stage', () => {
		const requested = requestFixtures()[mayaId];
		requested.financial.inquiryId = 'someone-else';
		expect(canDeclineInquiry(requested, everything)).toBe(false);
	});
});

describe('declined lifecycle presentation', () => {
	it('labels DECLINED as a terminal outcome, not a sixth booking step', () => {
		expect(lifecycleLabel('DECLINED')).toBe('Declined');
		expect(lifecycleTone('DECLINED')).toBe('rust');
		for (const stage of ['BOOKED', 'SERVED', 'CLOSED'] as const)
			expect(lifecycleTone(stage)).not.toBe('rust');
		const steps = progressSteps('DECLINED');
		expect(steps.map((step) => step.stage)).toEqual([
			'REQUESTED',
			'QUOTED',
			'BOOKED',
			'SERVED',
			'CLOSED'
		]);
		expect(steps.map((step) => step.state)).toEqual([
			'done',
			'skipped',
			'skipped',
			'skipped',
			'skipped'
		]);
		expect(steps.some((step) => step.state === 'current')).toBe(false);
		expect(progressSteps('BOOKED').map((step) => step.state)).toEqual([
			'done',
			'done',
			'current',
			'upcoming',
			'upcoming'
		]);
	});
	it('words Right now as a decided request with nothing pending', () => {
		const declined = declinedFixture();
		expect(requestSummary(declined, '2026-07-01')).toBe('Request declined');
		const description = requestSummaryDescription(declined, '2026-07-01');
		expect(description).toContain('No booking action is pending');
		expect(description).not.toMatch(/quote|deposit|balance|owed|due/i);
	});
	it('offers no Quote, payment or fulfillment action after a decline', () => {
		const declined = declinedFixture();
		expect(canIssueQuote(declined, everything)).toBe(false);
		expect(canRecordDeposit(declined, everything)).toBe(false);
		expect(canRecordInvoicePayment(declined, everything)).toBe(false);
		expect(canMarkServed(declined, everything)).toBe(false);
		expect(canCloseInquiry(declined, everything)).toBe(false);
	});
});

describe('declined projection validation', () => {
	it('accepts a coherent decline of the current Estimate at any version', () => {
		for (const version of [1, 2, 7]) {
			const declined = declinedFixture(version);
			expect(isCurrentStaffRequest(declined, mayaId)).toBe(true);
			// The Estimate itself is untouched history: lines, totals and reconciliation stay.
			const original = requestFixtures()[mayaId];
			expect(declined.financial.lines).toEqual(original.financial.lines);
			expect(declined.financial.total).toBe(original.financial.total);
			expect(declined.financial.reconciliation).toEqual(original.financial.reconciliation);
		}
		const multiline = declinedFixture(1, 'Date is booked.\nOffered Nov 21 instead.');
		expect(isCurrentStaffRequest(multiline, mayaId)).toBe(true);
	});
	it('keeps accepting null or absent `declined` on undeclined stages', () => {
		const requested = requestFixtures()[mayaId];
		requested.inquiry.lifecycle.declined = null;
		expect(isCurrentStaffRequest(requested, mayaId)).toBe(true);
		delete requested.inquiry.lifecycle.declined;
		expect(isCurrentStaffRequest(requested, mayaId)).toBe(true);
	});
	it('fails closed on a malformed or contradictory decline instead of reading it as REQUESTED', () => {
		const quoted = requestFixtures()['00000000-0000-0000-0000-000000000001'];
		const cases: [string, (data: ReturnType<typeof declinedFixture>) => void][] = [
			['missing provenance', (d) => delete d.inquiry.lifecycle.declined],
			['null provenance', (d) => (d.inquiry.lifecycle.declined = null)],
			['decline on a REQUESTED stage', (d) => (d.inquiry.lifecycle.stage = 'REQUESTED')],
			['another Estimate version', (d) => (d.inquiry.lifecycle.declined!.documentVersion = 2)],
			['zero version', (d) => (d.inquiry.lifecycle.declined!.documentVersion = 0)],
			['blank reason', (d) => (d.inquiry.lifecycle.declined!.reason = '   ')],
			['untrimmed reason', (d) => (d.inquiry.lifecycle.declined!.reason = ' late ')],
			[
				'overlong reason',
				(d) => (d.inquiry.lifecycle.declined!.reason = 'x'.repeat(DECLINE_REASON_MAX + 1))
			],
			[
				'SERVICE actor',
				(d) =>
					((d.inquiry.lifecycle.declined as { principalKind: string }).principalKind = 'SERVICE')
			],
			['missing actor', (d) => (d.inquiry.lifecycle.declined!.principalId = '')],
			['bad time', (d) => (d.inquiry.lifecycle.declined!.occurredAt = 'yesterday')],
			['a Quote document', (d) => (d.financial.stage = 'QUOTE')],
			['a proposal', (d) => (d.proposal = quoted.proposal)],
			[
				'a deposit requirement',
				(d) => (d.depositRequirement = { ...quoted.depositRequirement, documentId: d.financial.id })
			],
			[
				'invented fulfillment',
				(d) =>
					(d.inquiry.lifecycle.served = {
						occurredAt: '2026-10-21T00:00:00Z',
						principalKind: 'USER',
						principalId: 'staff'
					})
			],
			['another canonical document', (d) => (d.inquiry.lifecycle.documentId = 'other')]
		];
		for (const [name, mutate] of cases) {
			const data = declinedFixture();
			mutate(data);
			expect(isCurrentStaffRequest(data, mayaId), name).toBe(false);
			expect(canDeclineInquiry(data, everything), name).toBe(false);
		}
	});
	it('rejects decline provenance on any other stage', () => {
		const quoted = requestFixtures()['00000000-0000-0000-0000-000000000001'];
		quoted.inquiry.lifecycle.declined = declinedFixture().inquiry.lifecycle.declined;
		expect(isCurrentStaffRequest(quoted, quoted.inquiry.id)).toBe(false);
	});
});

describe('decline form', () => {
	it('reads exactly the reviewed version and reason', () => {
		expect(
			readDeclineForm(
				form([
					['expectedDocumentVersion', '3'],
					['reason', ' Date unavailable ']
				])
			)
		).toEqual({ expectedDocumentVersion: '3', reason: ' Date unavailable ' });
	});
	it('rejects duplicated, unexpected, missing or malformed fields', () => {
		const valid: [string, string][] = [
			['expectedDocumentVersion', '1'],
			['reason', 'Booked']
		];
		for (const entries of [
			[...valid, ['reason', 'again']],
			[...valid, ['expectedDocumentVersion', '1']],
			[...valid, ['inquiryId', mayaId]],
			[...valid, ['principalId', 'staff']],
			[...valid, ['occurredAt', '2026-10-20T20:00:00Z']],
			[...valid, ['stage', 'DECLINED']],
			[['reason', 'Booked']],
			[['expectedDocumentVersion', '1']],
			[
				['expectedDocumentVersion', '0'],
				['reason', 'x']
			],
			[
				['expectedDocumentVersion', '01'],
				['reason', 'x']
			],
			[
				['expectedDocumentVersion', '1.0'],
				['reason', 'x']
			],
			[
				['expectedDocumentVersion', '2147483648'],
				['reason', 'x']
			]
		] as [string, string][][])
			expect(readDeclineForm(form(entries))).toBeNull();
		const file = form(valid);
		file.set('reason', new Blob(['x']));
		expect(readDeclineForm(file)).toBeNull();
	});
	it('trims, keeps internal line breaks and enforces 1–500 characters', () => {
		expect(declineReason('  Date taken.\r\nOffered another.  ')).toBe(
			'Date taken.\nOffered another.'
		);
		expect(declineReasonProblem('')).toBe('blank');
		expect(declineReasonProblem(' \r\n\t ')).toBe('blank');
		expect(declineReasonProblem(`  ${'x'.repeat(DECLINE_REASON_MAX)}  `)).toBeNull();
		expect(declineReasonProblem('x'.repeat(DECLINE_REASON_MAX + 1))).toBe('too-long');
		// A form's CRLF line breaks count once, as the field showed them.
		expect(declineReasonProblem(`${'x'.repeat(249)}\r\n${'x'.repeat(250)}`)).toBeNull();
		expect(declineReasonMessage('blank')).toBe('Enter a reason for declining.');
	});
	it('maps outcomes to safe copy and treats an attempted 5xx as unconfirmed', () => {
		expect(declineErrorMessage(403)).toBe('This account cannot decline requests.');
		expect(declineErrorMessage(404)).toContain('no longer available');
		expect(declineErrorMessage(409)).toContain('Reload to review');
		expect(declineErrorMessage(422)).toContain('reason');
		expect(declineErrorMessage(503, true)).toBe(
			'We couldn’t confirm whether this request was declined. Reload to review its latest status before taking another action.'
		);
		expect(declineErrorMessage(503)).toContain('Nothing was declined');
		for (const status of [400, 403, 404, 409, 422, 500, 503])
			expect(declineErrorMessage(status, true)).not.toMatch(/PRIVATE|diagnostic|[0-9a-f]{8}-/i);
	});
});
