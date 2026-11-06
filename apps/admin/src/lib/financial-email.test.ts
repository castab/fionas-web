import { describe, expect, it } from 'vitest';
import {
	acceptedNoticeCopy,
	customerFirstName,
	emailCopy,
	emailDeliveryLabels,
	emailedVersionLabel,
	financialEmailError,
	missingEmailPermissionCopy,
	pacificTimeLabel,
	unavailableCopy,
	financialEmailMessage,
	financialEmailStatus,
	financialEmailTarget,
	hasFinancialEmailPermissions,
	intentVersionLabel,
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
		expect(emailedVersionLabel(record())).toBe('Quote v2');
	});

	it('labels staff emails with the business revision', () => {
		expect(
			emailedVersionLabel(record({ kind: 'INVOICE', documentVersion: 3, businessRevision: 4 }))
		).toBe('Invoice v4');
		const intent = {
			kind: 'QUOTE' as const,
			documentId: mayaDocumentId,
			expectedDocumentVersion: 2,
			expectedBusinessRevision: 3,
			proposalId,
			expectedDepositRequirementRevision: 1
		};
		expect(intentVersionLabel(intent)).toBe('Quote v3');
		expect(emailedVersionLabel(record({ businessRevision: 3 }))).toBe('Quote v3');
		expect(sameIntent(intent, { ...intent, expectedBusinessRevision: 2 })).toBe(false);
		expect(intentWithMessage(intent, '').expectedBusinessRevision).toBe(3);
	});
});

describe('staff copy', () => {
	it('names the customer by first name, with a neutral fallback', () => {
		expect(customerFirstName('  Maya   Torres ')).toBe('Maya');
		expect(customerFirstName('Cher')).toBe('Cher');
		expect(customerFirstName('   ')).toBe('the customer');
	});

	it('names the business time zone after the received-time label', () => {
		expect(pacificTimeLabel('2026-10-20T21:05:00Z')).toBe('Oct 20, 2026, 2:05 PM Pacific');
	});

	it('asks for access without listing permission names', () => {
		expect(missingEmailPermissionCopy).toBe(
			'Ask an administrator to turn on emailing for you. It needs access to send email and to manage payment links.'
		);
		expect(financialEmailError('forbidden')).toBe(missingEmailPermissionCopy);
		expect(missingEmailPermissionCopy).not.toMatch(/fionas\.|commerce\.|financial-document/);
	});

	it('words each panel and status sentence plainly', () => {
		const when = 'Oct 20, 2026, 2:05 PM Pacific';
		expect(emailCopy.intro('QUOTE', 'Maya')).toBe(
			'Sends the current Quote to Maya in this booking’s email thread, with their payment link. Nothing goes out until you press Send quote.'
		);
		expect(emailCopy.intro('INVOICE', 'Maya')).toBe(
			'Sends the current Invoice and what’s still owed to Maya in this booking’s email thread, with their payment link. Nothing goes out until you press Send invoice.'
		);
		expect(emailCopy.already('QUOTE', 'Maya', when)).toBe(
			'Maya already got this Quote on Oct 20, 2026, 2:05 PM Pacific. Sending again emails them another copy.'
		);
		expect(emailCopy.current('INVOICE', 'Maya', when, 'staff')).toBe(
			'This Invoice was emailed to Maya Oct 20, 2026, 2:05 PM Pacific by staff.'
		);
		expect(emailCopy.never('QUOTE')).toBe(
			'This Quote hasn’t been emailed. Publishing it didn’t send anything.'
		);
		expect(emailCopy.never('INVOICE')).toBe(
			'This Invoice hasn’t been emailed. Marking it served didn’t send anything.'
		);
		expect(emailCopy.earlier('QUOTE', 'Quote v1', when)).toBe(
			'Only an earlier Quote was emailed (Quote v1, Oct 20, 2026, 2:05 PM Pacific). The current one hasn’t been sent.'
		);
		expect(emailCopy.unknown('QUOTE', when)).toBe(
			'We can’t tell if the Quote email from Oct 20, 2026, 2:05 PM Pacific went out.'
		);
		expect(emailCopy.unknownNext(true)).toBe('You can check it again in the email panel.');
		expect(emailCopy.unknownNext(false)).toBe(
			'Only the original send can be checked. Don’t send another.'
		);
		expect(emailCopy.rejected(when)).toBe(
			'The last attempt (Oct 20, 2026, 2:05 PM Pacific) was refused by the email provider, so it wasn’t sent.'
		);
		expect(emailCopy.lost('7f3c9e21-5b4a-4d0e-9a61-0c2e8f4b13d7')).toBe(
			'This browser doesn’t have the original email, so it can’t check it. Don’t send a new one. Ask an administrator to look into send ID 7f3c9e21-5b4a-4d0e-9a61-0c2e8f4b13d7.'
		);
		expect(emailCopy.footnote(when, 'abc', true)).toBe(
			'Previewed Oct 20, 2026, 2:05 PM Pacific · Send ID abc. This browser keeps the previewed email for 30 days so it can be checked; check again before then.'
		);
		expect(emailCopy.footnote(when, undefined, false)).toBe(
			'Previewed Oct 20, 2026, 2:05 PM Pacific.'
		);
	});

	it('confirms a send once, distinguishing a replay', () => {
		expect(acceptedNoticeCopy('QUOTE', false)).toBe('Sent just now.');
		expect(acceptedNoticeCopy('INVOICE', true)).toBe(
			'This Invoice email already went out earlier, so nothing new was sent.'
		);
	});

	it('explains settled and overpaid Invoices plainly', () => {
		expect(unavailableCopy.no_balance).toBe(
			'It’s paid in full, so there’s nothing to collect by email.'
		);
		expect(unavailableCopy.credit).toBe(
			'It’s overpaid, so there’s nothing to collect by email. Sort out the credit outside this workflow.'
		);
	});

	it('points every uncertain outcome at Check again, never at a new send', () => {
		expect(financialEmailError('anything_else', true)).toBe(
			'We can’t tell if this email went out. Use Check again: it repeats the original send exactly and never sends a second copy.'
		);
		expect(financialEmailError('email_send_rejected')).toContain('nothing went out');
		for (const code of ['anything_else', 'financial_email_reconciliation_required'])
			expect(financialEmailError(code, true)).not.toMatch(/Reconcile/);
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
