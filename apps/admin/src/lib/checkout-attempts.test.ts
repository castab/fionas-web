import { describe, expect, it } from 'vitest';
import {
	attemptsNeedingAttention,
	classifyAttempt,
	compareMinor,
	currentPaymentTerms,
	reconcileFeedback,
	supersededCopy
} from './checkout-attempts.js';
import type { PaymentAttempt } from './customer-payments.js';
import type { CurrentStaffRequest } from './request-contract.js';

/** Only the fields the classifier reads; the rest of the projection is irrelevant here. */
function quoted(overrides: { version?: number; revision?: number | null; deposit?: string } = {}) {
	return {
		financial: {
			stage: 'QUOTE',
			version: overrides.version ?? 3,
			reconciliation: { grossAllocated: '0.00', netApplied: '0.00', balance: '715.00' }
		},
		currentQuoteRevision: overrides.revision === undefined ? 3 : overrides.revision,
		depositRequirement: {
			state: 'ACTIVE',
			requiredAmount: { amount: overrides.deposit ?? '300.00', currency: 'USD' }
		}
	} as unknown as CurrentStaffRequest;
}
function invoiced(balance = '415.00', revision: number | null = 4) {
	return {
		financial: {
			stage: 'INVOICE',
			version: 4,
			reconciliation: { grossAllocated: '300.00', netApplied: '300.00', balance }
		},
		currentInvoiceRevision: revision,
		depositRequirement: { state: 'NONE' }
	} as unknown as CurrentStaffRequest;
}
let sequence = 0;
function attempt(overrides: Partial<PaymentAttempt> = {}): PaymentAttempt {
	sequence++;
	return {
		id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
		purpose: 'DEPOSIT',
		authorizedMinor: 30000,
		documentVersion: 3,
		businessRevision: 3,
		state: 'OPEN',
		outcome: 'PENDING',
		createdAt: new Date(Date.UTC(2026, 10, 1, 18, sequence)).toISOString(),
		expiresAt: '2026-11-09T19:00:00Z',
		...overrides
	};
}

describe('compareMinor', () => {
	it('compares whole cents with exact decimals, never rounding', () => {
		expect(compareMinor(30000, '300.00')).toBe(0);
		expect(compareMinor(30000, '300')).toBe(0);
		expect(compareMinor(30000, '300.001')).toBe(-1);
		expect(compareMinor(30001, '300.001')).toBe(1);
		expect(compareMinor(0, '-0.01')).toBe(1);
		expect(compareMinor(12345678901234, '123456789012.34')).toBe(0);
		expect(compareMinor(100, 'NaN')).toBeNull();
		expect(compareMinor(100, '1e3')).toBeNull();
	});
});

describe('currentPaymentTerms', () => {
	it('reads the Quote deposit and the Invoice balance from the staff request only', () => {
		expect(currentPaymentTerms(quoted())).toEqual({
			purpose: 'DEPOSIT',
			documentVersion: 3,
			businessRevision: 3,
			amount: '300.00'
		});
		expect(currentPaymentTerms(invoiced())).toEqual({
			purpose: 'INVOICE',
			documentVersion: 4,
			businessRevision: 4,
			amount: '415.00'
		});
		const estimate = { ...quoted(), financial: { ...quoted().financial, stage: 'ESTIMATE' } };
		expect(currentPaymentTerms(estimate as CurrentStaffRequest)).toBeNull();
		expect(currentPaymentTerms(null)).toBeNull();
	});
});

describe('classifyAttempt', () => {
	const terms = currentPaymentTerms(quoted());

	it('keeps an OPEN checkout for the current Quote current', () => {
		expect(classifyAttempt(attempt(), terms)).toEqual({ status: 'open_current', reasons: [] });
	});

	it('marks an OPEN checkout for an earlier Quote revision superseded', () => {
		// Quote v2 → v3 with a new ledger version (a topping change repriced a line).
		expect(classifyAttempt(attempt({ documentVersion: 2, businessRevision: 2 }), terms)).toEqual({
			status: 'open_superseded',
			reasons: ['document', 'revision']
		});
		// A service- or deposit-only publication advances only the business revision.
		expect(classifyAttempt(attempt({ businessRevision: 2 }), terms).reasons).toEqual(['revision']);
		// A changed deposit amount under the same revisions still can't be the same authorization.
		expect(classifyAttempt(attempt({ authorizedMinor: 25000 }), terms).reasons).toEqual(['amount']);
	});

	it('marks a deposit checkout superseded once the booking has an Invoice', () => {
		const invoiceTerms = currentPaymentTerms(invoiced());
		expect(
			classifyAttempt(attempt({ documentVersion: 4, businessRevision: 4 }), invoiceTerms)
		).toEqual({ status: 'open_superseded', reasons: ['purpose'] });
	});

	it('compares an Invoice payment with the authoritative balance, at most', () => {
		const invoiceTerms = currentPaymentTerms(invoiced('415.00'));
		const invoice = (minor: number) =>
			attempt({
				purpose: 'INVOICE',
				authorizedMinor: minor,
				documentVersion: 4,
				businessRevision: 4
			});
		expect(classifyAttempt(invoice(41500), invoiceTerms).status).toBe('open_current');
		expect(classifyAttempt(invoice(10000), invoiceTerms).status).toBe('open_current');
		expect(classifyAttempt(invoice(41501), invoiceTerms)).toEqual({
			status: 'open_superseded',
			reasons: ['amount']
		});
		// Paid in full elsewhere: no balance left for the open checkout.
		expect(classifyAttempt(invoice(41500), currentPaymentTerms(invoiced('0.00'))).status).toBe(
			'open_superseded'
		);
	});

	it('never asserts obsolescence it cannot prove', () => {
		// Commerce did not report the business revision: only a status check is offered.
		const noRevision = currentPaymentTerms(quoted({ revision: null }));
		expect(classifyAttempt(attempt(), noRevision).status).toBe('open_unverified');
		// No active deposit to compare the amount with.
		const withdrawn = { ...quoted(), depositRequirement: { state: 'WITHDRAWN' } };
		expect(
			classifyAttempt(attempt(), currentPaymentTerms(withdrawn as unknown as CurrentStaffRequest))
				.status
		).toBe('open_unverified');
		expect(classifyAttempt(attempt({ purpose: 'TIP' }), terms).status).toBe('open_unverified');
		expect(classifyAttempt(attempt(), null).status).toBe('open_unverified');
		// …but a mismatch it *can* see still counts, even when something else is missing.
		expect(classifyAttempt(attempt({ documentVersion: 2 }), noRevision).status).toBe(
			'open_superseded'
		);
	});

	it('classifies every provider state and outcome without release claims', () => {
		const status = (overrides: Partial<PaymentAttempt>) =>
			classifyAttempt(attempt({ documentVersion: 1, businessRevision: 1, ...overrides }), terms)
				.status;
		expect(status({ state: 'CREATING' })).toBe('creating');
		expect(status({ state: 'PROCESSING' })).toBe('processing');
		expect(status({ state: 'SUCCEEDED' })).toBe('paid_pending');
		expect(status({ state: 'EXPIRED' })).toBe('expired');
		expect(status({ state: 'FAILED' })).toBe('failed');
		expect(status({ state: 'SUCCEEDED', outcome: 'APPLIED' })).toBe('applied');
		// Money captured against obsolete terms is reconciliation, never "superseded" or cancelled.
		expect(status({ state: 'SUCCEEDED', outcome: 'RECONCILIATION_REQUIRED' })).toBe(
			'reconciliation_required'
		);
		expect(status({ state: 'OPEN', outcome: 'RECONCILIATION_REQUIRED' })).toBe(
			'reconciliation_required'
		);
		expect(status({ state: 'PAUSED' })).toBe('unrecognized');
		expect(status({ outcome: 'REFUNDED' })).toBe('unrecognized');
	});
});

describe('attemptsNeedingAttention', () => {
	it('offers release only for superseded OPEN checkouts and checks for uncertain ones', () => {
		const terms = currentPaymentTerms(quoted());
		const old = attempt({ documentVersion: 2, businessRevision: 2 });
		const current = attempt();
		const creating = attempt({ state: 'CREATING' });
		const processing = attempt({ state: 'PROCESSING' });
		const expired = attempt({ state: 'EXPIRED', documentVersion: 1, businessRevision: 1 });
		const applied = attempt({ state: 'SUCCEEDED', outcome: 'APPLIED' });
		const stuck = attempt({ state: 'SUCCEEDED', outcome: 'RECONCILIATION_REQUIRED' });
		const items = attemptsNeedingAttention(
			[old, current, creating, processing, expired, applied, stuck],
			terms
		);
		// Newest first; current, settled, released and reconciliation attempts are not repeated.
		expect(items.map((item) => [item.attempt.id, item.kind])).toEqual([
			[processing.id, 'confirming'],
			[creating.id, 'unconfirmed'],
			[old.id, 'release']
		]);
		expect(attemptsNeedingAttention(null, terms)).toEqual([]);
	});
});

describe('supersededCopy', () => {
	it('names the staff revisions it could compare', () => {
		const terms = currentPaymentTerms(quoted());
		const old = attempt({ documentVersion: 2, businessRevision: 2 });
		expect(supersededCopy(old, ['document', 'revision'], terms)).toBe(
			'It was started for Quote v2; the current terms are Quote v3.'
		);
		expect(supersededCopy(old, ['purpose'], currentPaymentTerms(invoiced()))).toContain(
			'the booking now has an Invoice'
		);
		expect(supersededCopy(attempt(), ['amount'], terms)).toContain('deposit required now');
	});
});

describe('reconcileFeedback', () => {
	const feedback = (state: string, outcome = 'PENDING') => reconcileFeedback({ state, outcome });

	it('says released only for provider-confirmed EXPIRED, without promising payability', () => {
		expect(feedback('EXPIRED')).toMatchObject({ tone: 'positive', settlement: false });
		expect(feedback('EXPIRED').text).toContain('released');
		expect(feedback('EXPIRED').text).toContain('if the current terms allow it');
		for (const state of ['OPEN', 'CREATING', 'PROCESSING', 'FAILED', 'SUCCEEDED'])
			expect(feedback(state).text).not.toMatch(/it’s released|was released|cancel/i);
		expect(feedback('OPEN').text).toContain('wasn’t released');
	});

	it('keeps payments distinct from checkout releases and never suggests refunds', () => {
		expect(feedback('PROCESSING')).toMatchObject({ tone: 'warning', settlement: false });
		expect(feedback('PROCESSING').text).toContain('Don’t start or record another payment');
		expect(feedback('SUCCEEDED', 'APPLIED')).toMatchObject({ tone: 'positive', settlement: true });
		const stuck = feedback('SUCCEEDED', 'RECONCILIATION_REQUIRED');
		expect(stuck).toMatchObject({ tone: 'warning', settlement: true });
		expect(stuck.text).toContain('needs staff reconciliation');
		for (const [state, outcome] of [
			['SUCCEEDED', 'APPLIED'],
			['SUCCEEDED', 'RECONCILIATION_REQUIRED'],
			['EXPIRED', 'PENDING']
		])
			expect(feedback(state, outcome).text).not.toMatch(/refund|lost|cancelled/i);
	});

	it('treats an unknown answer as unconfirmed', () => {
		expect(feedback('PAUSED')).toMatchObject({ unconfirmed: true, settlement: true });
		expect(feedback('OPEN', 'MYSTERY')).toMatchObject({ unconfirmed: true });
		expect(feedback('EXPIRED').unconfirmed).toBeUndefined();
	});
});
