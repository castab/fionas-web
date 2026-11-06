import { describe, expect, it } from 'vitest';
import {
	emailDeliveryLabels,
	emailedVersionLabel,
	financialEmailMessage,
	financialEmailStatus,
	financialEmailTarget,
	hasFinancialEmailPermissions,
	intentWithMessage,
	isFinancialEmailHistory,
	isFinancialEmailPreview,
	isFinancialEmailSendResponse,
	sameIntent
} from './financial-email.js';
import { previewDocument } from './email-preview.js';
import {
	FINANCIAL_EMAIL_PERMISSIONS,
	type FinancialEmailHistory
} from './financial-email-contract.js';
import type { CurrentStaffRequest } from './request-contract.js';
import { paymentFixture, mayaId, mayaDocumentId } from '../../e2e/request-fixture.mjs';

const proposalId = `3${mayaId.slice(1)}`;
function quoted(overrides: Partial<CurrentStaffRequest> = {}): CurrentStaffRequest {
	return { ...paymentFixture('quoted'), currentQuoteRevision: 2, ...overrides };
}
function served(balance = '415.00'): CurrentStaffRequest {
	const request = paymentFixture('served');
	request.currentQuoteRevision = 2;
	request.acceptedQuoteRevision = 2;
	request.currentInvoiceRevision = 4;
	request.financial.reconciliation.balance = balance;
	return request;
}
function intentOf(request: CurrentStaffRequest) {
	const target = financialEmailTarget(request);
	if (!target || !('intent' in target)) throw new Error('Expected an eligible target');
	return target.intent;
}
const record = (overrides: Partial<FinancialEmailHistory> = {}): FinancialEmailHistory => ({
	sendId: '40000000-0000-4000-8000-000000000001',
	kind: 'QUOTE',
	documentId: mayaDocumentId,
	documentVersion: 2,
	businessRevision: 2,
	proposalId,
	current: true,
	outcome: 'ACCEPTED',
	requestedAt: '2026-07-17T18:00:00Z',
	acceptedAt: '2026-07-17T18:00:01Z',
	actor: { principalKind: 'USER', principalId: 'me' },
	messageId: '50000000-0000-4000-8000-000000000001',
	sendState: 'accepted',
	...overrides
});

describe('financial email target', () => {
	it('resolves a QUOTED request to the exact Quote identities, business revision included', () => {
		expect(financialEmailTarget(quoted())).toEqual({
			kind: 'QUOTE',
			intent: {
				kind: 'QUOTE',
				documentId: mayaDocumentId,
				expectedDocumentVersion: 2,
				expectedBusinessRevision: 2,
				proposalId,
				expectedDepositRequirementRevision: 1
			}
		});
	});

	it('never substitutes the ledger version for a missing business revision', () => {
		expect(financialEmailTarget(quoted({ currentQuoteRevision: undefined }))).toEqual({
			kind: 'QUOTE',
			unavailable: 'revision_unavailable'
		});
		const request = quoted();
		request.proposal = { ...request.proposal!, quoteRevision: 3 };
		expect(financialEmailTarget(request)).toMatchObject({ unavailable: 'revision_unavailable' });
	});

	it('refuses a Quote whose publication is not the current document or deposit', () => {
		const request = quoted();
		request.proposal = { ...request.proposal!, documentVersion: 1 };
		expect(financialEmailTarget(request)).toMatchObject({ unavailable: 'not_current' });
	});

	it('offers SERVED Invoices only with a positive balance', () => {
		expect(financialEmailTarget(served())).toEqual({
			kind: 'INVOICE',
			intent: {
				kind: 'INVOICE',
				documentId: mayaDocumentId,
				expectedDocumentVersion: 3,
				expectedBusinessRevision: 4
			}
		});
		expect(financialEmailTarget(served('0.00'))).toMatchObject({ unavailable: 'no_balance' });
		expect(financialEmailTarget(served('-5.00'))).toMatchObject({ unavailable: 'credit' });
	});

	it('offers nothing while REQUESTED, BOOKED, CLOSED or DECLINED', () => {
		for (const stage of ['REQUESTED', 'BOOKED', 'CLOSED', 'DECLINED'] as const) {
			const request = served();
			request.inquiry.lifecycle.stage = stage;
			expect(financialEmailTarget(request)).toBeNull();
		}
	});

	it('compares every reviewed identity', () => {
		const a = intentOf(quoted());
		expect(sameIntent(a, { ...a, expectedBusinessRevision: 3 })).toBe(false);
		expect(sameIntent(a, { ...a })).toBe(true);
	});

	it('requires all five permissions', () => {
		expect(hasFinancialEmailPermissions([...FINANCIAL_EMAIL_PERMISSIONS])).toBe(true);
		for (const missing of FINANCIAL_EMAIL_PERMISSIONS)
			expect(
				hasFinancialEmailPermissions(FINANCIAL_EMAIL_PERMISSIONS.filter((p) => p !== missing))
			).toBe(false);
	});
});

describe('financial email message', () => {
	it('normalizes newlines and trims edges, preserving paragraphs', () => {
		expect(financialEmailMessage('  Hello!\r\n\r\nSee you soon.\t \r\n')).toEqual({
			ok: true,
			message: 'Hello!\n\nSee you soon.'
		});
		expect(financialEmailMessage(' \n ')).toEqual({ ok: true, message: '' });
	});

	it('counts UTF-16 units against the 2,000 limit', () => {
		expect(financialEmailMessage('a'.repeat(2000)).ok).toBe(true);
		expect(financialEmailMessage('a'.repeat(2001))).toEqual({ ok: false, problem: 'length' });
		expect(financialEmailMessage('🍦'.repeat(1001))).toEqual({ ok: false, problem: 'length' });
	});

	it('refuses controls and malformed Unicode, allowing tabs', () => {
		expect(financialEmailMessage('a\u0007b')).toEqual({ ok: false, problem: 'characters' });
		expect(financialEmailMessage('a\u0085b')).toEqual({ ok: false, problem: 'characters' });
		expect(financialEmailMessage('a\ud800b')).toEqual({ ok: false, problem: 'characters' });
		expect(financialEmailMessage('a\tb 🍦').ok).toBe(true);
	});

	it('omits a blank message and Quote-only identities from an Invoice body', () => {
		const invoice = intentOf(served());
		expect(intentWithMessage(invoice, '')).not.toHaveProperty('message');
		expect(intentWithMessage(invoice, 'Hi')).not.toHaveProperty('proposalId');
	});
});

describe('financial email responses', () => {
	const intent = intentOf(quoted());
	const preview = () => ({
		kind: 'QUOTE',
		recipientName: 'Maya',
		recipientAddress: 'maya@example.com',
		subject: 'Your quote from Fiona’s Ice Cream',
		html: '<p>Preview</p>',
		text: 'Preview',
		financial: { ...quoted().financial },
		businessRevision: 2,
		requiredPayment: '300.00',
		paidAmount: '0.00',
		balance: '715.00',
		balanceAfterDeposit: '415.00',
		reviewToken: 'a'.repeat(64)
	});

	it('accepts only a preview of exactly the reviewed identity', () => {
		expect(isFinancialEmailPreview(preview(), intent, mayaId)).toBe(true);
		expect(isFinancialEmailPreview({ ...preview(), businessRevision: 3 }, intent, mayaId)).toBe(
			false
		);
		expect(isFinancialEmailPreview({ ...preview(), requiredPayment: 300 }, intent, mayaId)).toBe(
			false
		);
		expect(isFinancialEmailPreview({ ...preview(), reviewToken: 'x' }, intent, mayaId)).toBe(false);
		expect(isFinancialEmailPreview(preview(), intent, 'other')).toBe(false);
	});

	it('classifies send statuses exactly', () => {
		const accepted = { sendId: record().sendId, outcome: 'ACCEPTED', replayed: false };
		expect(isFinancialEmailSendResponse(accepted, 201)).toBe(true);
		expect(isFinancialEmailSendResponse({ ...accepted, replayed: true }, 200)).toBe(true);
		expect(isFinancialEmailSendResponse({ ...accepted, outcome: 'UNKNOWN' }, 202)).toBe(true);
		// An ACCEPTED body on 202, or a 200 that claims to be new, is ambiguous.
		expect(isFinancialEmailSendResponse(accepted, 202)).toBe(false);
		expect(isFinancialEmailSendResponse(accepted, 200)).toBe(false);
		expect(isFinancialEmailSendResponse({ outcome: 'ACCEPTED' }, 201)).toBe(false);
	});

	it('validates history records, including Quote-only proposal identity', () => {
		expect(isFinancialEmailHistory(record())).toBe(true);
		expect(isFinancialEmailHistory(record({ proposalId: null }))).toBe(false);
		expect(isFinancialEmailHistory(record({ kind: 'INVOICE' }))).toBe(false);
		expect(isFinancialEmailHistory(record({ kind: 'INVOICE', proposalId: undefined }))).toBe(true);
		expect(isFinancialEmailHistory(record({ outcome: 'UNKNOWN' }))).toBe(false); // acceptedAt
		expect(
			isFinancialEmailHistory(
				record({ outcome: 'UNKNOWN', acceptedAt: undefined, sendState: null })
			)
		).toBe(true);
	});
});

describe('financial email status', () => {
	it('derives never, current, earlier and unknown from commerce history only', () => {
		expect(financialEmailStatus([], 'QUOTE').summary).toBe('never');
		expect(financialEmailStatus(undefined, 'QUOTE').summary).toBe('never');
		expect(financialEmailStatus([record()], 'QUOTE').summary).toBe('current');
		// Same ledger version but not current per commerce (e.g. a deposit-only republication).
		const earlier = financialEmailStatus([record({ current: false })], 'QUOTE');
		expect(earlier.summary).toBe('earlier');
		expect(earlier.current).toBeUndefined();
		const unknown = record({
			sendId: '40000000-0000-4000-8000-000000000002',
			outcome: 'UNKNOWN',
			acceptedAt: null,
			requestedAt: '2026-07-18T18:00:00Z'
		});
		expect(financialEmailStatus([unknown], 'QUOTE').summary).toBe('unknown');
		const both = financialEmailStatus([record(), unknown], 'QUOTE');
		expect(both.summary).toBe('current');
		expect(both.unknown).toEqual([unknown]);
		// Invoice history is separate.
		expect(financialEmailStatus([record()], 'INVOICE').summary).toBe('never');
	});

	it('keeps a rejected latest attempt distinct from acceptance', () => {
		const rejected = record({
			sendId: '40000000-0000-4000-8000-000000000003',
			outcome: 'REJECTED',
			acceptedAt: null,
			requestedAt: '2026-07-19T18:00:00Z'
		});
		const status = financialEmailStatus([rejected, record()], 'QUOTE');
		expect(status.summary).toBe('current');
		expect(status.rejected).toBe(rejected);
		expect(financialEmailStatus([rejected], 'QUOTE').summary).toBe('never');
	});

	it('never labels provider acceptance as delivery', () => {
		expect(emailDeliveryLabels(record())).toEqual([
			'Accepted by email provider',
			'Delivery not confirmed'
		]);
		expect(emailDeliveryLabels(record({ sendState: null, deliveryState: null }))).toEqual([
			'Accepted by email provider',
			'Delivery not confirmed'
		]);
		expect(emailDeliveryLabels(record({ deliveryState: 'delivered' }))).toContain('Delivered');
		expect(emailDeliveryLabels(record({ sendState: 'pending' }))[0]).toBe(
			'Queued with email provider'
		);
		expect(emailedVersionLabel(record())).toBe('Quote v2 · revision 2');
	});
});

describe('email preview isolation', () => {
	it('adds a restrictive policy inside the document head and removes refresh navigation', () => {
		const doc = previewDocument(
			'<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://example.invalid/payment-preview"><title>x</title></head><body><a href="https://example.invalid/payment-preview">Pay</a><img src="https://cdn.example/logo.png"><script>alert(1)</script></body></html>'
		);
		expect(doc.startsWith('<!doctype html><html><head><base target="_blank">')).toBe(true);
		expect(doc).toContain(
			`content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'"`
		);
		expect(doc).not.toMatch(/http-equiv="refresh"/i);
		expect(
			previewDocument('<a target="_self" href="x">a</a><a TARGET=_top href=y>b</a>')
		).not.toMatch(/target=(?!"_blank")/i);
	});

	it('wraps a fragment in a complete document', () => {
		expect(previewDocument('<p>Hi</p>')).toMatch(
			/^<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><meta http-equiv="Content-Security-Policy".*<body><p>Hi<\/p><\/body><\/html>$/
		);
	});
});
