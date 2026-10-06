import { describe, expect, it } from 'vitest';
import { isPaymentHistory } from './payment-history.js';
import { paymentFixture, mayaId, appendPayment } from '../../e2e/request-fixture.mjs';
import {
	canRecordDeposit,
	canRecordInvoicePayment,
	invoiceAmountValid,
	PAYMENT_PERMISSION,
	paymentMethodLabel,
	readPaymentForm,
	receivedTimeLabel
} from './payments.js';
import { isCurrentStaffRequest, PROPOSAL_PERMISSIONS } from './request-workspace.js';

describe('manual payments', () => {
	it('keeps an authoritative negative balance readable without payment controls', () => {
		const request = paymentFixture('booked');
		appendPayment(request, '115.01', 'CHECK', 3);
		expect(request.financial.reconciliation.balance).toBe('-0.01');
		expect(isCurrentStaffRequest(request, mayaId)).toBe(true);
		expect(canRecordInvoicePayment(request, [PAYMENT_PERMISSION])).toBe(false);
	});
	it('requires payment permission, payable lifecycle and coherent reviewed pair', () => {
		const quoted = paymentFixture();
		expect(canRecordDeposit(quoted, [PAYMENT_PERMISSION])).toBe(true);
		expect(canRecordDeposit(quoted, [...PROPOSAL_PERMISSIONS])).toBe(false);
		quoted.proposal!.documentVersion++;
		expect(canRecordDeposit(quoted, [PAYMENT_PERMISSION])).toBe(false);
		for (const state of ['booked', 'additional', 'refunded', 'served'] as const) {
			const request = paymentFixture(state);
			expect(canRecordDeposit(request, [PAYMENT_PERMISSION])).toBe(false);
			expect(canRecordInvoicePayment(request, [PAYMENT_PERMISSION])).toBe(true);
			expect(canRecordInvoicePayment(request, [])).toBe(false);
			request.inquiry.lifecycle.stage = 'CLOSED';
			expect(canRecordInvoicePayment(request, [PAYMENT_PERMISSION])).toBe(false);
			request.inquiry.lifecycle.stage = 'BOOKED';
			request.financial.reconciliation.balance = '0.00';
			expect(canRecordInvoicePayment(request, [PAYMENT_PERMISSION])).toBe(false);
		}
	});
	it('compares exact amounts with currency precision, including amounts beyond floating point precision', () => {
		for (const amount of [
			'0',
			'-1',
			'+1',
			'1e2',
			'.50',
			'1.',
			'100.001',
			'700.01',
			'NaN',
			'',
			' 100'
		])
			expect(invoiceAmountValid(amount, '700.00', 'USD')).toBe(false);
		for (const amount of ['100', '100.00', '0250.50', '700.00', '0.01'])
			expect(invoiceAmountValid(amount, '700.00', 'USD')).toBe(true);
		expect(invoiceAmountValid('1.001', '2.000', 'KWD')).toBe(true);
		expect(invoiceAmountValid('1.01', '2', 'JPY')).toBe(false);
		expect(invoiceAmountValid('9007199254740993.02', '9007199254740993.01', 'USD')).toBe(false);
		expect(invoiceAmountValid('9007199254740993.01', '9007199254740993.01', 'USD')).toBe(true);
	});
	it('fails closed for the receipt fields consumed, while allowing future payment methods', () => {
		const request = paymentFixture('refunded');
		expect(isCurrentStaffRequest(request, mayaId)).toBe(true);
		expect(request.payments[0].reconciliation.netReceived).toBe('0.00');
		expect(request.payments[0].allocations[0].documentVersion).toBe(2);
		expect(request.financial.version).toBe(3);
		request.payments[0].payment.method = 'FUTURE_METHOD';
		expect(isPaymentHistory(request.payments[0])).toBe(true);
		expect(paymentMethodLabel('FUTURE_METHOD')).toBe('Unknown payment method');
		for (const method of ['constructor', '__proto__', 'toString'])
			expect(paymentMethodLabel(method)).toBe('Unknown payment method');
		expect(paymentMethodLabel('CHECK')).toBe('Check');
		expect(receivedTimeLabel('2026-10-06T19:01:00Z')).toContain('12:01 PM');
		for (const key of [
			'payments',
			'payment.amount',
			'payment.currency',
			'payment.receivedAt',
			'payment.method',
			'reconciliation.totalRefunded',
			'reconciliation.netReceived',
			'allocations'
		] as const) {
			const partial = paymentFixture('refunded');
			if (key === 'payments') Reflect.deleteProperty(partial, key);
			else {
				const [object, field] = key.split('.');
				if (field) Reflect.deleteProperty(Reflect.get(partial.payments[0], object), field);
				else Reflect.deleteProperty(partial.payments[0], object);
			}
			expect(isCurrentStaffRequest(partial, mayaId), key).toBe(false);
		}
	});
	it('strictly accepts only reviewed fields and the three manual methods', () => {
		const form = new FormData();
		form.set('expectedVersion', '2');
		form.set('method', 'CASH');
		form.set('expectedProposalId', paymentFixture().proposal!.id);
		expect(readPaymentForm(form, true)).toMatchObject({ expectedVersion: '2', method: 'CASH' });
		for (const method of ['CARD', 'BANK_TRANSFER', 'DIGITAL_WALLET', 'MONEY_ORDER', 'cash', '']) {
			form.set('method', method);
			expect(readPaymentForm(form, true)).toBeNull();
		}
		form.set('method', 'OTHER');
		form.append('method', 'CHECK');
		expect(readPaymentForm(form, true)).toBeNull();
		form.delete('method');
		form.set('method', 'CHECK');
		form.set('amount', '100.00');
		expect(readPaymentForm(form, true)).toBeNull();
	});
});
