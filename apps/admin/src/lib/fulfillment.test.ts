import { describe, expect, it } from 'vitest';
import {
	canMarkServed,
	canCloseInquiry,
	FULFILLMENT_PERMISSION,
	isExactZero,
	fulfillmentErrorMessage
} from './request-workspace.js';
import { paymentFixture, requestFixtures, mayaId } from '../../e2e/request-fixture.mjs';

const permissions = [FULFILLMENT_PERMISSION];
describe('explicit fulfillment eligibility', () => {
	it('serves a booked Invoice regardless of its date or balance', () => {
		const data = paymentFixture('booked');
		for (const eventDate of ['2000-01-01', '2099-12-31']) {
			data.inquiry.eventDate = eventDate;
			for (const balance of ['115.00', '0.00', '-5.00']) {
				data.financial.reconciliation.balance = balance;
				expect(canMarkServed(data, permissions)).toBe(true);
			}
		}
	});
	it('rejects every other stage and non-Invoice lineage', () => {
		const requested = requestFixtures()[mayaId];
		expect(canMarkServed(requested, permissions)).toBe(false);
		expect(canCloseInquiry(requested, permissions)).toBe(false);
		for (const stage of ['QUOTED', 'SERVED', 'CLOSED'] as const) {
			const data = paymentFixture(stage === 'QUOTED' ? 'quoted' : 'served');
			data.inquiry.lifecycle.stage = stage;
			expect(canMarkServed(data, permissions)).toBe(false);
		}
		const data = paymentFixture('booked');
		data.financial.stage = 'QUOTE';
		expect(canMarkServed(data, permissions)).toBe(false);
		data.inquiry.lifecycle.stage = 'SERVED';
		data.financial.reconciliation.balance = '0';
		expect(canCloseInquiry(data, permissions)).toBe(false);
	});
	it.each(['0', '0.0', '0.00', '000.000', '-0.00'])(
		'closes a coherent served Invoice at exact %s',
		(balance) => {
			const data = paymentFixture('served');
			data.financial.reconciliation.balance = balance;
			expect(canCloseInquiry(data, permissions)).toBe(true);
		}
	);
	it.each(['25.00', '-5.00', '0.000000000000000000001', '-0.000000000000000000001'])(
		'blocks nonzero balance %s',
		(balance) => {
			const data = paymentFixture('served');
			data.financial.reconciliation.balance = balance;
			expect(canCloseInquiry(data, permissions)).toBe(false);
		}
	);
	it('does not close BOOKED or CLOSED even with zero balance', () => {
		const data = paymentFixture('booked');
		data.financial.reconciliation.balance = '0';
		for (const stage of ['BOOKED', 'CLOSED'] as const) {
			data.inquiry.lifecycle.stage = stage;
			expect(canCloseInquiry(data, permissions)).toBe(false);
		}
	});
	it('requires fulfillment permission independently of payment or proposal permissions', () => {
		const data = paymentFixture('booked');
		for (const permissions of [
			[],
			['commerce.payment.record'],
			['commerce.financial-document.create', 'commerce.deposit-requirement.manage']
		]) {
			expect(canMarkServed(data, permissions)).toBe(false);
			data.inquiry.lifecycle.stage = 'SERVED';
			data.financial.reconciliation.balance = '0';
			expect(canCloseInquiry(data, permissions)).toBe(false);
			data.inquiry.lifecycle.stage = 'BOOKED';
		}
	});
	it('fails closed on incoherent projection', () => {
		const data = paymentFixture('booked');
		data.financial.inquiryId = 'other';
		expect(canMarkServed(data, permissions)).toBe(false);
		data.inquiry.lifecycle.stage = 'SERVED';
		data.financial.reconciliation.balance = '0';
		expect(canCloseInquiry(data, permissions)).toBe(false);
	});
	it('rejects malformed zero strings without rounding', () => {
		for (const value of ['', '0e0', '+0', ' 0', '0.', 'NaN', '0.01'])
			expect(isExactZero(value)).toBe(false);
	});
	it('distinguishes read failure from ambiguous mutation for both actions', () => {
		for (const action of ['markServed', 'closeInquiry'] as const) {
			expect(fulfillmentErrorMessage(503, action)).toContain('couldn’t review');
			expect(fulfillmentErrorMessage(500, action, true)).toContain('couldn’t confirm whether');
			expect(fulfillmentErrorMessage(409, action, true)).toContain('Reload to review');
		}
	});
});
