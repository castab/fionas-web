import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actions } from '../../routes/(app)/requests/[inquiryId]/+page.server.js';
import { getStaffRequest, recordPayment } from '$lib/server/staff-request.js';
import { applySetCookies } from '$lib/server/auth.js';
import { PAYMENT_PERMISSION } from '$lib/payments.js';
import {
	appendPayment,
	mayaId,
	mayaDocumentId,
	paymentFixture
} from '../../../e2e/request-fixture.mjs';

vi.mock('$lib/server/staff-request.js', () => ({
	markInquiryServed: vi.fn(),
	closeInquiry: vi.fn(),
	getStaffRequest: vi.fn(),
	recordPayment: vi.fn(),
	issueInquiryProposal: vi.fn()
}));
vi.mock('$lib/server/auth.js', () => ({ applySetCookies: vi.fn() }));
vi.mock('$lib/server/config.js', () => ({
	backendConfig: () => ({ baseUrl: 'http://api.test', origin: 'http://admin.test' })
}));

function event(
	deposit = true,
	fields: Record<string, string | undefined> = {},
	permissions = [PAYMENT_PERMISSION]
) {
	const body = new FormData();
	for (const [key, value] of Object.entries({
		expectedVersion: deposit ? '2' : '3',
		method: 'CASH',
		...(deposit ? { expectedProposalId: paymentFixture().proposal!.id } : { amount: '100.00' }),
		...fields
	}))
		if (value !== undefined) body.set(key, value);
	return {
		params: { inquiryId: mayaId },
		url: new URL(`http://admin.test/requests/${mayaId}?/recordDeposit`),
		request: new Request('http://admin.test', {
			method: 'POST',
			headers: { cookie: 'session=staff' },
			body
		}),
		locals: { user: { id: 'staff', roles: ['commerce.administrator'], permissions } },
		cookies: {}
	} as unknown as Parameters<typeof actions.recordDeposit>[0];
}
function failure(status: number) {
	return {
		ok: false as const,
		error: { status, code: 'failure', message: 'PRIVATE diagnostic', violations: [] },
		retryAfter: null
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getStaffRequest).mockResolvedValue({
		ok: true,
		data: paymentFixture(),
		setCookies: ['session=read']
	});
	vi.mocked(recordPayment).mockResolvedValue({
		ok: true,
		data: appendPayment(paymentFixture(), '300.00', 'CASH', 2),
		setCookies: ['session=renewed']
	});
});

describe('reviewed payment actions', () => {
	it('derives the exact full deposit and document identity from the route projection; PRGs to a clean GET', async () => {
		await expect(actions.recordDeposit(event())).rejects.toMatchObject({
			status: 303,
			location: `/requests/${mayaId}`
		});
		expect(getStaffRequest).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			mayaId,
			'session=staff'
		);
		expect(recordPayment).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			mayaDocumentId,
			{
				documentVersion: 2,
				expectedProposalId: paymentFixture().proposal!.id,
				amount: '300.00',
				method: 'CASH'
			},
			'session=staff'
		);
		expect(applySetCookies).toHaveBeenCalledWith(expect.anything(), ['session=renewed']);
	});
	it.each(['CASH', 'CHECK', 'OTHER'])(
		'preserves an Invoice decimal string and omits proposal ID for %s',
		async (method) => {
			vi.mocked(getStaffRequest).mockResolvedValue({
				ok: true,
				data: paymentFixture('booked'),
				setCookies: []
			});
			await expect(
				actions.recordInvoicePayment(event(false, { amount: '0100.50', method }))
			).rejects.toMatchObject({ status: 303, location: `/requests/${mayaId}` });
			expect(recordPayment).toHaveBeenCalledExactlyOnceWith(
				expect.anything(),
				mayaDocumentId,
				{ documentVersion: 3, amount: '0100.50', method },
				'session=staff'
			);
		}
	);
	it.each([
		{ permissions: [] },
		{ permissions: ['commerce.financial-document.create', 'commerce.deposit-requirement.manage'] }
	])(
		'denies missing permission even for Administrator before backend access',
		async ({ permissions }) => {
			for (const action of [actions.recordDeposit, actions.recordInvoicePayment])
				expect(await action(event(true, {}, permissions))).toMatchObject({ status: 403 });
			expect(getStaffRequest).not.toHaveBeenCalled();
			expect(recordPayment).not.toHaveBeenCalled();
		}
	);
	it('redirects a signed-out user', async () => {
		const request = event();
		request.locals.user = null;
		await expect(actions.recordDeposit(request)).rejects.toMatchObject({
			status: 303,
			location: '/login'
		});
		expect(getStaffRequest).not.toHaveBeenCalled();
	});
	it.each([
		{ documentId: mayaDocumentId },
		{ inquiryId: mayaId },
		{ amount: '100.00' },
		{ currency: 'USD' },
		{ expectedVersion: '0' },
		{ expectedVersion: '2.0' },
		{ expectedVersion: '2147483648' },
		{ expectedProposalId: 'invalid' },
		{ method: 'CARD' },
		{ method: 'BANK_TRANSFER' },
		{ method: 'DIGITAL_WALLET' },
		{ method: 'MONEY_ORDER' },
		{ externalReference: 'check number' },
		{ receivedAt: '2026-10-06' }
	])('rejects malformed deposit envelope %j without backend calls', async (fields) => {
		expect(await actions.recordDeposit(event(true, fields))).toMatchObject({ status: 422 });
		expect(getStaffRequest).not.toHaveBeenCalled();
		expect(recordPayment).not.toHaveBeenCalled();
	});
	it.each(['duplicate', 'file', 'missing', 'unreadable'])(
		'rejects %s form fields',
		async (kind) => {
			const request = event();
			const form = await request.request.formData();
			if (kind === 'duplicate') form.append('method', 'CHECK');
			if (kind === 'file') form.set('method', new Blob(['CASH']), 'method.txt');
			if (kind === 'missing') form.delete('method');
			request.request = new Request('http://admin.test', {
				method: 'POST',
				body: kind === 'unreadable' ? 'invalid' : form
			});
			expect(await actions.recordDeposit(request)).toMatchObject({ status: 422 });
			expect(getStaffRequest).not.toHaveBeenCalled();
		}
	);
	it.each(['version', 'proposal', 'booked', 'refunded'])(
		'requires review instead of retargeting %s',
		async (change) => {
			const data = paymentFixture(change === 'booked' || change === 'refunded' ? change : 'quoted');
			if (change === 'version') {
				data.financial.version++;
				data.proposal!.documentVersion++;
				if (data.depositRequirement.state === 'ACTIVE')
					data.depositRequirement.approvalDocumentVersion++;
			}
			if (change === 'proposal') data.proposal!.id = '30000000-0000-0000-0000-000000000099';
			vi.mocked(getStaffRequest).mockResolvedValue({ ok: true, data, setCookies: [] });
			expect(await actions.recordDeposit(event())).toMatchObject({
				status: 409,
				data: { paymentReviewRequired: true }
			});
			expect(recordPayment).not.toHaveBeenCalled();
		}
	);
	it.each(['0', '-1', '115.01', '1e2', '100.001', ''])(
		'refuses Invoice amount %s without mutation',
		async (amount) => {
			vi.mocked(getStaffRequest).mockResolvedValue({
				ok: true,
				data: paymentFixture('booked'),
				setCookies: []
			});
			expect(await actions.recordInvoicePayment(event(false, { amount }))).toMatchObject({
				status: 422
			});
			expect(recordPayment).not.toHaveBeenCalled();
		}
	);
	it('refuses a stale Invoice version and extra proposal or document fields', async () => {
		vi.mocked(getStaffRequest).mockResolvedValue({
			ok: true,
			data: paymentFixture('booked'),
			setCookies: []
		});
		expect(
			await actions.recordInvoicePayment(event(false, { expectedVersion: '2' }))
		).toMatchObject({ status: 409, data: { paymentReviewRequired: true } });
		for (const fields of [
			{ expectedProposalId: paymentFixture().proposal!.id },
			{ documentId: mayaDocumentId }
		])
			expect(await actions.recordInvoicePayment(event(false, fields))).toMatchObject({
				status: 422
			});
		expect(recordPayment).not.toHaveBeenCalled();
	});
	it.each([403, 404, 409, 400, 422, 500, 503])(
		'safely handles mutation %i without retry; blocks until reload',
		async (status) => {
			vi.mocked(recordPayment).mockResolvedValue(failure(status));
			const result = await actions.recordDeposit(event());
			expect(result).toMatchObject({
				status: status >= 500 ? 503 : status,
				data: { paymentReviewRequired: true }
			});
			expect(JSON.stringify(result)).not.toContain('PRIVATE');
			if (status >= 500)
				expect(result).toMatchObject({
					data: { paymentError: expect.stringContaining('couldn’t confirm whether') }
				});
			expect(recordPayment).toHaveBeenCalledOnce();
		}
	);
	it('read failures do not claim an ambiguous mutation; missing projection fields fail closed', async () => {
		vi.mocked(getStaffRequest).mockResolvedValue(failure(503));
		expect(await actions.recordDeposit(event())).toMatchObject({
			data: { paymentError: expect.stringContaining('couldn’t review') }
		});
		const data = paymentFixture();
		Reflect.deleteProperty(data, 'payments');
		vi.mocked(getStaffRequest).mockResolvedValue({ ok: true, data, setCookies: [] });
		expect(await actions.recordDeposit(event())).toMatchObject({ status: 503 });
		expect(recordPayment).not.toHaveBeenCalled();
	});
	it.each(['read', 'mutation'])('redirects backend 401 at %s', async (stage) => {
		if (stage === 'read') vi.mocked(getStaffRequest).mockResolvedValue(failure(401));
		else vi.mocked(recordPayment).mockResolvedValue(failure(401));
		await expect(actions.recordDeposit(event())).rejects.toMatchObject({
			status: 303,
			location: '/login'
		});
	});
});
