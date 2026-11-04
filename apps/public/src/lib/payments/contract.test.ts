import { describe, expect, it } from 'vitest';
import {
	checkoutRedirect,
	readCheckoutCommand,
	readCheckoutResponse,
	readPaymentError,
	readPaymentSummary,
	serializeCommand
} from './contract.js';
import { documentLabel, eventDateLabel, paidPercent, paymentView, stageLabel } from './view.js';
import { bookedSummary, openCheckout, quotedSummary } from './testing/fixtures.js';

const view = (value: Record<string, unknown>) => paymentView(readPaymentSummary(value)!);

describe('payment summary contract', () => {
	it('accepts the documented example and defaults checkoutRecoveryAvailable', () => {
		const legacy: Record<string, unknown> = quotedSummary();
		delete legacy.checkoutRecoveryAvailable;
		expect(readPaymentSummary(legacy)?.checkoutRecoveryAvailable).toBe(false);
		expect(readPaymentSummary(quotedSummary())).toMatchObject({ requiredAmount: '240.00' });
	});

	it('whitelists customer-safe fields and drops anything else', () => {
		const summary = readPaymentSummary(
			quotedSummary({ customerEmail: 'x@example.com', staffNote: 'private' })
		)!;
		expect(Object.keys(summary)).not.toContain('customerEmail');
		expect(JSON.stringify(summary)).not.toContain('private');
	});

	it.each([
		['float money', { requiredAmount: 240 }],
		['sub-cent money', { balance: '1200.001' }],
		['missing history', { history: undefined }],
		['bad receipt', { history: [{ amount: '1.00' }] }],
		['bad date', { eventDate: '05/01/2027' }],
		['bad flag', { canPay: 'true' }],
		['lowercase enum', { lifecycle: 'quoted' }],
		['bad recovery flag', { checkoutRecoveryAvailable: 'yes' }]
	])('refuses %s', (_, overrides) => {
		expect(readPaymentSummary(quotedSummary(overrides))).toBeNull();
	});

	it('refuses an incoherent document', () => {
		const summary = quotedSummary();
		expect(
			readPaymentSummary({ ...summary, document: { ...summary.document, version: 0 } })
		).toBeNull();
	});
});

describe('payment view', () => {
	it('labels by business revision, never the ledger version', () => {
		const summary = readPaymentSummary(quotedSummary())!;
		expect(documentLabel(summary)).toBe('Quote v4');
		expect(documentLabel(readPaymentSummary(bookedSummary())!)).toBe('Invoice v8');
		expect(stageLabel(summary)).toBe('Quote ready');
		expect(eventDateLabel('2027-05-01')).toBe('Saturday, May 1, 2027');
	});

	it('offers the exact deposit while QUOTED', () => {
		expect(view(quotedSummary())).toEqual({
			kind: 'deposit-due',
			terms: { purpose: 'DEPOSIT', amountCents: 24000n, documentVersion: 3, businessRevision: 4 }
		});
	});

	it('offers the Invoice balance while BOOKED or SERVED', () => {
		expect(view(bookedSummary())).toMatchObject({
			kind: 'balance-due',
			terms: { amountCents: 96000n, fullAllowed: true, documentVersion: 6, businessRevision: 8 }
		});
		expect(view(bookedSummary({ lifecycle: 'SERVED' })).kind).toBe('balance-due');
		expect(paidPercent(readPaymentSummary(bookedSummary())!)).toBe(20);
	});

	it('requires a partial payment when the balance exceeds Stripe maximum', () => {
		const big = view(bookedSummary({ requiredAmount: '1500000.00', balance: '1500000.00' }));
		expect(big).toMatchObject({ kind: 'balance-due', terms: { fullAllowed: false } });
	});

	it.each([
		['CLOSED', { lifecycle: 'CLOSED', canPay: false, unavailableReason: 'CLOSED' }, 'closed'],
		['reconciliation', { reconciliationPending: true, canPay: false }, 'reconciliation'],
		['in progress', { paymentInProgress: true, canPay: false }, 'in-progress'],
		['paid', { canPay: false, unavailableReason: 'NO_PAYMENT_DUE' }, 'no-balance'],
		['small', { canPay: false, unavailableReason: 'BELOW_STRIPE_MINIMUM' }, 'staff-assist'],
		['unknown reason', { canPay: false, unavailableReason: 'NEW_REASON' }, 'unavailable'],
		['no reason', { canPay: false }, 'unavailable'],
		['currency', { canPay: false, unavailableReason: 'UNSUPPORTED_CURRENCY' }, 'unavailable'],
		['incoherent', { canPay: true, unavailableReason: 'CLOSED' }, 'unavailable'],
		['unknown lifecycle', { lifecycle: 'ARCHIVED' }, 'unavailable'],
		['requested', { lifecycle: 'REQUESTED' }, 'unavailable'],
		['mode mismatch', { mode: 'INVOICE' }, 'unavailable'],
		['unknown mode', { mode: 'SUBSCRIPTION' }, 'unavailable']
	])('fails closed or reads %s', (_, overrides, kind) => {
		expect(view(quotedSummary(overrides)).kind).toBe(kind);
	});

	it('only offers recovery terms when commerce says a check is available', () => {
		expect(view(quotedSummary({ paymentInProgress: true, canPay: false }))).toEqual({
			kind: 'in-progress',
			recovery: null
		});
		expect(
			view(
				quotedSummary({ paymentInProgress: true, canPay: false, checkoutRecoveryAvailable: true })
			)
		).toMatchObject({ kind: 'in-progress', recovery: { purpose: 'DEPOSIT', amountCents: 24000n } });
	});

	it('shows a credit after an overpayment', () => {
		expect(
			view(bookedSummary({ canPay: false, unavailableReason: 'NO_PAYMENT_DUE', balance: '-5.00' }))
		).toEqual({ kind: 'no-balance', creditCents: 500n });
	});
});

describe('checkout contract', () => {
	it('redirects only to an OPEN Stripe-hosted HTTPS Checkout', () => {
		const response = readCheckoutResponse(openCheckout)!;
		expect(checkoutRedirect(response)).toBe(openCheckout.url);
		for (const url of [
			'http://checkout.stripe.com/c/pay/x',
			'https://checkout.stripe.com.evil.test/c',
			'https://evil.test/c',
			'javascript:alert(1)',
			'https://user@checkout.stripe.com/c'
		])
			expect(checkoutRedirect({ ...response, url })).toBeNull();
		expect(checkoutRedirect({ ...response, state: 'PROCESSING' })).toBeNull();
		expect(checkoutRedirect({ ...response, url: undefined })).toBeNull();
	});

	it('reads only the documented command fields, canonically', () => {
		expect(
			readCheckoutCommand({ expectedDocumentVersion: 3, expectedBusinessRevision: 4 })
		).toEqual({ expectedDocumentVersion: 3, expectedBusinessRevision: 4 });
		for (const bad of [
			{ expectedDocumentVersion: 3, expectedBusinessRevision: 4, currency: 'EUR' },
			{ expectedDocumentVersion: 3, expectedBusinessRevision: 4, totalAmount: '1.00' },
			{ expectedDocumentVersion: 3, expectedBusinessRevision: 4, amountMinor: 49 },
			{ expectedDocumentVersion: 3, expectedBusinessRevision: 4, amountMinor: 100.5 },
			{ expectedDocumentVersion: 3, expectedBusinessRevision: 4, amountMinor: 100_000_000 },
			{ expectedDocumentVersion: 0, expectedBusinessRevision: 4 },
			{ expectedDocumentVersion: '3', expectedBusinessRevision: 4 },
			[]
		])
			expect(readCheckoutCommand(bad)).toBeNull();
		expect(
			serializeCommand({
				amountMinor: 10000,
				expectedBusinessRevision: 8,
				expectedDocumentVersion: 6
			})
		).toBe('{"expectedDocumentVersion":6,"expectedBusinessRevision":8,"amountMinor":10000}');
	});

	it('keeps only stable error codes and known conflict messages', () => {
		expect(readPaymentError({ code: 'conflict', message: 'PAYMENT_TERMS_CHANGED' })).toEqual({
			code: 'conflict',
			message: 'PAYMENT_TERMS_CHANGED'
		});
		expect(readPaymentError({ code: 'conflict', message: 'SQL detail leaked' })).toEqual({
			code: 'conflict'
		});
		expect(readPaymentError({ code: 'Bad Code' })).toBeNull();
	});
});
