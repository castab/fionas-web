import { describe, expect, it } from 'vitest';
import {
	checkoutLaunch,
	checkoutRedirect,
	inspectCheckoutResponse,
	readCheckoutCommand,
	readCheckoutResponse,
	readPaymentError,
	readPaymentSummary,
	serializeCommand
} from './contract.js';
import { documentLabel, eventDateLabel, paidPercent, paymentView, stageLabel } from './view.js';
import {
	bookedSummary,
	embeddedCheckout,
	embeddedSecret,
	legacyOpenCheckout,
	openCheckout,
	quotedSummary,
	restartEligible,
	restartToken
} from './testing/fixtures.js';

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

	it('never carries customer identity, contact details or conversation content', () => {
		const leaked = {
			customerName: 'Maria Lopez',
			name: 'Maria Lopez',
			email: 'maria@example.com',
			phone: '+1 555 0100',
			address: '1 Main St',
			zipCode: '94110',
			message: 'PRIVATE conversation text',
			servicePlan: { description: 'PRIVATE service description' }
		};
		const booked = bookedSummary(leaked) as {
			document: Record<string, unknown>;
			history: Record<string, unknown>[];
		};
		const summary = readPaymentSummary({
			...booked,
			document: { ...booked.document, customerName: 'Maria Lopez' },
			history: [{ ...booked.history[0], payerEmail: 'maria@example.com' }]
		});
		expect(summary).not.toBeNull();
		const serialized = JSON.stringify(summary);
		for (const value of ['Maria', 'maria@example.com', '555', 'Main St', '94110', 'PRIVATE'])
			expect(serialized).not.toContain(value);
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
	it('offers restart independently of the recovery hint and canPay', () => {
		expect(
			view(bookedSummary({ ...restartEligible, checkoutRecoveryAvailable: false }))
		).toMatchObject({
			kind: 'in-progress',
			recovery: null,
			restart: { token: restartToken, terms: { purpose: 'INVOICE', amountCents: 96000n } }
		});
	});

	it.each([
		{ checkoutRestartToken: undefined },
		{ checkoutRestartToken: 'untrusted' },
		{ checkoutRestartToken: null },
		{ reconciliationPending: true },
		{ unavailableReason: 'NO_PAYMENT_DUE' },
		{ unavailableReason: 'UNSUPPORTED_CURRENCY' },
		{ lifecycle: 'CLOSED' },
		{ paymentInProgress: false },
		{ balance: '0.00' }
	])('suppresses restart for an absent or invalid token or incoherent terms (%j)', (overrides) => {
		expect(view(bookedSummary({ ...restartEligible, ...overrides }))).not.toHaveProperty('restart');
	});

	it('labels the document without generated version numbers, keeping revisions internal', () => {
		const summary = readPaymentSummary(quotedSummary())!;
		expect(documentLabel(summary)).toBe('Quote');
		const booked = readPaymentSummary(bookedSummary())!;
		expect(documentLabel(booked)).toBe('Invoice');
		// The exact concurrency inputs survive for checkout, even though they are never displayed.
		expect(booked.document).toMatchObject({ businessRevision: 8, acceptedQuoteRevision: 4 });
		expect(paymentView(booked)).toMatchObject({ terms: { businessRevision: 8 } });
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
	it('round-trips only a well-formed opaque restart token', () => {
		const command = {
			expectedDocumentVersion: 6,
			expectedBusinessRevision: 8,
			amountMinor: 15000,
			restartToken
		};
		expect(readCheckoutCommand(JSON.parse(serializeCommand(command)))).toEqual(command);
		for (const malformed of [
			null,
			'token',
			restartToken + '!',
			restartToken.replace(/^.{36}/, '-'.repeat(36))
		])
			expect(readCheckoutCommand({ ...command, restartToken: malformed })).toBeNull();
	});

	it('validates the optional replaced attempt ID', () => {
		const replacedAttemptId = embeddedCheckout.attemptId;
		expect(readCheckoutResponse({ ...openCheckout, replacedAttemptId })).toMatchObject({
			replacedAttemptId
		});
		expect(readCheckoutResponse(openCheckout)).not.toHaveProperty('replacedAttemptId');
		expect(readCheckoutResponse({ ...openCheckout, replacedAttemptId: 'invalid' })).toBeNull();
	});

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

	it('reads a hosted, embedded or legacy-hosted OPEN answer by its own mode', () => {
		expect(readCheckoutResponse(openCheckout)).toEqual(openCheckout);
		expect(checkoutLaunch(readCheckoutResponse(openCheckout)!)).toEqual({
			mode: 'HOSTED',
			url: openCheckout.url
		});
		const embedded = readCheckoutResponse(embeddedCheckout)!;
		expect(embedded).toEqual(embeddedCheckout);
		expect(embedded.attemptId).toBe(embeddedCheckout.attemptId);
		expect(checkoutLaunch(embedded)).toEqual({ mode: 'EMBEDDED', clientSecret: embeddedSecret });
		expect(checkoutRedirect(embedded)).toBeNull();
		// Deploy overlap only: a url and no mode is HOSTED; EMBEDDED is never inferred.
		expect(readCheckoutResponse(legacyOpenCheckout)).toEqual({
			...legacyOpenCheckout,
			uiMode: 'HOSTED'
		});
	});

	it('accepts any well-formed client secret: Stripe documents no format for it', () => {
		// Shapes a Stripe API release could plausibly return; none may be refused by format.
		for (const clientSecret of [
			'cs_test_a1YS1URlnyQCN5fUUduORoQ7Pw41PJqDWkIVQCpJPqkfIhd6tVY8XB1OLY_secret_fidwbEhqYWAnPyd',
			'cs_live_b2c3_secret_fid-dWxOYHwnPyd1blpxYHZxWjA0-Tg',
			'cs_test_a1b2#fidkdWxOYHwnPyd1blpxYHZxWjA0%2B%3D',
			'cs_test_short',
			'ecs_1Q2w3E4r5T6y_secret_AbC+/=',
			`cs_test_${'a'.repeat(3000)}`
		]) {
			const read = readCheckoutResponse({ ...embeddedCheckout, clientSecret });
			expect(read, clientSecret.slice(0, 40)).not.toBeNull();
			expect(checkoutLaunch(read!)).toEqual({ mode: 'EMBEDDED', clientSecret });
		}
	});

	it('launches Elements only with its own client secret on an OPEN answer', () => {
		const elements = { ...embeddedCheckout, uiMode: 'ELEMENTS' } as const;
		expect(readCheckoutResponse(elements)).toEqual(elements);
		expect(checkoutLaunch(elements)).toEqual({ mode: 'ELEMENTS', clientSecret: embeddedSecret });
		for (const bad of [
			{ ...elements, clientSecret: undefined },
			{ ...elements, clientSecret: undefined, url: openCheckout.url },
			{ ...elements, url: openCheckout.url },
			{ ...elements, clientSecret: 'sk_test_notAClientSecret123' }
		])
			expect(readCheckoutResponse(bad)).toBeNull();
		const closed = readCheckoutResponse({ ...elements, state: 'EXPIRED', url: openCheckout.url })!;
		expect(closed).toEqual({
			attemptId: elements.attemptId,
			uiMode: 'ELEMENTS',
			state: 'EXPIRED',
			outcome: elements.outcome
		});
		expect(checkoutLaunch(closed)).toBeNull();
	});

	it('names the failed check without echoing any value', () => {
		const cases: [unknown, string][] = [
			[[], 'not_object'],
			[{ ...embeddedCheckout, attemptId: 'x' }, 'attempt_id'],
			[{ ...embeddedCheckout, state: 'open' }, 'state'],
			[{ ...embeddedCheckout, outcome: 1 }, 'outcome'],
			[{ ...embeddedCheckout, uiMode: 'POPUP' }, 'ui_mode'],
			[{ ...openCheckout, url: 'x'.repeat(5000) }, 'url'],
			[{ ...embeddedCheckout, clientSecret: 'has space' }, 'client_secret'],
			[{ ...embeddedCheckout, url: openCheckout.url }, 'credentials'],
			[{ ...embeddedCheckout, clientSecret: undefined }, 'credentials']
		];
		for (const [value, problem] of cases)
			expect(inspectCheckoutResponse(value), problem).toEqual({ problem });
		expect(inspectCheckoutResponse(embeddedCheckout)).toEqual({ response: embeddedCheckout });
	});

	it('refuses unknown modes and contradictory or incomplete OPEN answers', () => {
		const { url } = openCheckout;
		const clientSecret = embeddedSecret;
		for (const bad of [
			{ ...openCheckout, uiMode: 'POPUP' },
			{ ...openCheckout, uiMode: 'embedded' },
			{ ...openCheckout, uiMode: 7 },
			{ ...openCheckout, clientSecret },
			{ ...embeddedCheckout, url },
			{ ...embeddedCheckout, clientSecret: undefined },
			{ ...embeddedCheckout, clientSecret: '' },
			{ ...embeddedCheckout, clientSecret: 'sk_test_notAClientSecret123' },
			{ ...embeddedCheckout, clientSecret: 'rk_live_notAClientSecret123' },
			{ ...embeddedCheckout, clientSecret: 'cs_test_bad secret' },
			{ ...embeddedCheckout, clientSecret: 'cs_test_line\nbreak' },
			{ ...embeddedCheckout, clientSecret: 'cs_test_été' },
			{ ...embeddedCheckout, clientSecret: `cs_test_${'a'.repeat(5000)}` },
			{ ...embeddedCheckout, clientSecret: 42 },
			{ ...openCheckout, url: undefined },
			{ ...openCheckout, url: '' },
			{ ...legacyOpenCheckout, url: undefined, clientSecret },
			{ ...legacyOpenCheckout, clientSecret },
			{ attemptId: openCheckout.attemptId, state: 'OPEN', outcome: 'PENDING' }
		])
			expect(readCheckoutResponse(bad), JSON.stringify(bad)).toBeNull();
	});

	it('keeps the state of a non-OPEN answer but never a launch credential', () => {
		for (const state of ['PROCESSING', 'SUCCEEDED', 'EXPIRED', 'FAILED']) {
			const hosted = readCheckoutResponse({ ...openCheckout, state, outcome: 'PAID' })!;
			expect(hosted).toEqual({
				attemptId: openCheckout.attemptId,
				uiMode: 'HOSTED',
				state,
				outcome: 'PAID'
			});
			const embedded = readCheckoutResponse({ ...embeddedCheckout, state })!;
			expect(JSON.stringify(embedded)).not.toContain(embeddedSecret);
			expect(embedded.uiMode).toBe('EMBEDDED');
			expect(checkoutLaunch(hosted)).toBeNull();
			expect(checkoutLaunch(embedded)).toBeNull();
		}
		expect(readCheckoutResponse({ ...legacyOpenCheckout, state: 'EXPIRED' })).toEqual({
			attemptId: openCheckout.attemptId,
			state: 'EXPIRED',
			outcome: 'PENDING'
		});
	});

	it('launches hosted Checkout only on Stripe’s allowlisted host', () => {
		const response = readCheckoutResponse(openCheckout)!;
		for (const url of ['https://evil.test/c', 'https://checkout.stripe.com:444/c'])
			expect(checkoutLaunch({ ...response, url })).toBeNull();
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
