import { describe, expect, it } from 'vitest';
import {
	canIssueQuote,
	financialStageLabel,
	isCurrentStaffRequest,
	lifecycleLabel,
	lifecycleStages,
	QUOTE_PERMISSION,
	quoteErrorMessage,
	requestErrorKind,
	requestSummary
} from './request-workspace.js';
import {
	durationLabel,
	eventDateLabel,
	eventTypeLabel,
	guestCountLabel,
	submittedDateLabel
} from './presentation.js';
import { mayaId, requestFixtures } from '../../e2e/request-fixture.mjs';

describe('request workspace presentation', () => {
	it('presents lifecycle from the inquiry, independently of the financial facts', () => {
		const data = requestFixtures()[mayaId];
		expect(requestSummary(data.inquiry.lifecycle.stage)).toBe('Needs a quote');
		data.financial.stage = 'QUOTE';
		data.financial.reconciliation.balance = '0.00';
		expect(requestSummary(data.inquiry.lifecycle.stage)).toBe('Needs a quote');
		data.inquiry.lifecycle.stage = 'QUOTED';
		data.financial.stage = 'ESTIMATE';
		expect(requestSummary(data.inquiry.lifecycle.stage)).toBe('Quote issued');
		expect(canIssueQuote(data, [QUOTE_PERMISSION])).toBe(false);
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
	it('requires both eligible state and the permission, regardless of role', () => {
		const data = requestFixtures()[mayaId];
		expect(canIssueQuote(data, [])).toBe(false);
		expect(canIssueQuote(data, [QUOTE_PERMISSION])).toBe(true);
		data.financial.stage = 'QUOTE';
		expect(canIssueQuote(data, [QUOTE_PERMISSION])).toBe(false);
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
	it('formats requested duration and minimum guests without repricing', () => {
		expect(durationLabel(90)).toBe('90 minutes');
		expect(durationLabel(60)).toBe('1 hour');
		expect(durationLabel(180)).toBe('3 hours');
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
