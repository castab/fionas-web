import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actions } from '../../routes/(app)/requests/[inquiryId]/+page.server.js';
import { getStaffRequest, markInquiryServed, closeInquiry } from '$lib/server/staff-request.js';
import { applySetCookies } from '$lib/server/auth.js';
import { FULFILLMENT_PERMISSION } from '$lib/request-workspace.js';
import { mayaId, paymentFixture } from '../../../e2e/request-fixture.mjs';

vi.mock('$lib/server/staff-request.js', () => ({
	getStaffRequest: vi.fn(),
	markInquiryServed: vi.fn(),
	closeInquiry: vi.fn(),
	recordPayment: vi.fn(),
	issueInquiryProposal: vi.fn()
}));
vi.mock('$lib/server/auth.js', () => ({ applySetCookies: vi.fn() }));
vi.mock('$lib/server/config.js', () => ({
	backendConfig: () => ({ baseUrl: 'http://api.test', origin: 'http://admin.test' })
}));
function event(permissions = [FULFILLMENT_PERMISSION], body: BodyInit = new FormData()) {
	return {
		params: { inquiryId: mayaId },
		url: new URL(`http://admin.test/requests/${mayaId}?/markServed`),
		request: new Request('http://admin.test', {
			method: 'POST',
			headers: { cookie: 'session=staff' },
			body
		}),
		locals: { user: { id: 'staff', roles: ['commerce.administrator'], permissions } },
		cookies: {}
	} as unknown as Parameters<typeof actions.markServed>[0];
}
function failure(status: number) {
	return {
		ok: false as const,
		error: { status, code: 'failure', message: 'PRIVATE diagnostic', violations: [] },
		retryAfter: null
	};
}
function projection(close: boolean) {
	const data = paymentFixture(close ? 'served' : 'booked');
	if (close) data.financial.reconciliation.balance = '0.00';
	return data;
}
beforeEach(() => {
	vi.clearAllMocks();
	for (const mutate of [markInquiryServed, closeInquiry])
		vi.mocked(mutate).mockResolvedValue({
			ok: true,
			data: { documentId: 'ignored', stage: 'REQUESTED' },
			setCookies: ['session=renewed']
		});
});
for (const close of [false, true])
	describe(close ? 'close action' : 'serve action', () => {
		const action = close ? actions.closeInquiry : actions.markServed;
		const mutate = close ? closeInquiry : markInquiryServed;
		beforeEach(() => {
			vi.mocked(getStaffRequest).mockResolvedValue({
				ok: true,
				data: projection(close),
				setCookies: ['session=read']
			});
		});
		it('re-reads route projection then mutates once, propagates cookies, and PRGs ignoring response state', async () => {
			await expect(action(event())).rejects.toMatchObject({
				status: 303,
				location: `/requests/${mayaId}`
			});
			expect(getStaffRequest).toHaveBeenCalledExactlyOnceWith(
				expect.anything(),
				mayaId,
				'session=staff'
			);
			expect(mutate).toHaveBeenCalledExactlyOnceWith(expect.anything(), mayaId, 'session=staff');
			expect(vi.mocked(getStaffRequest).mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(mutate).mock.invocationCallOrder[0]
			);
			expect(applySetCookies).toHaveBeenCalledWith(expect.anything(), ['session=read']);
			expect(applySetCookies).toHaveBeenCalledWith(expect.anything(), ['session=renewed']);
		});
		it('checks permission and session before all backend access', async () => {
			for (const permissions of [
				[],
				['commerce.payment.record'],
				['commerce.financial-document.create', 'commerce.deposit-requirement.manage']
			])
				expect(await action(event(permissions))).toMatchObject({ status: 403 });
			const signedOut = event();
			signedOut.locals.user = null;
			await expect(action(signedOut)).rejects.toMatchObject({ status: 303, location: '/login' });
			expect(getStaffRequest).not.toHaveBeenCalled();
			expect(mutate).not.toHaveBeenCalled();
		});
		it.each([
			'inquiryId',
			'documentId',
			'eventDate',
			'balance',
			'stage',
			'principalId',
			'occurredAt',
			'expectedVersion'
		])('rejects posted %s before backend access', async (key) => {
			const body = new FormData();
			body.set(key, 'other');
			expect(await action(event(undefined, body))).toMatchObject({ status: 422 });
			expect(getStaffRequest).not.toHaveBeenCalled();
			expect(mutate).not.toHaveBeenCalled();
		});
		it('rejects duplicates, files and unreadable bodies', async () => {
			const duplicate = new FormData();
			duplicate.append('inquiryId', mayaId);
			duplicate.append('inquiryId', 'other');
			const file = new FormData();
			file.set('file', new Blob(['data']), 'data.txt');
			for (const body of [duplicate, file, 'unreadable'])
				expect(await action(event(undefined, body))).toMatchObject({ status: 422 });
			expect(getStaffRequest).not.toHaveBeenCalled();
			expect(mutate).not.toHaveBeenCalled();
		});
		it.each(['owner', 'document', 'payments', 'reconciliation'])(
			'fails closed on incoherent %s',
			async (kind) => {
				const data = projection(close);
				if (kind === 'owner') data.inquiry.id = 'other';
				if (kind === 'document') data.inquiry.lifecycle.documentId = 'other';
				if (kind === 'payments') Reflect.deleteProperty(data, 'payments');
				if (kind === 'reconciliation') Reflect.deleteProperty(data.financial, 'reconciliation');
				vi.mocked(getStaffRequest).mockResolvedValue({ ok: true, data, setCookies: [] });
				expect(await action(event())).toMatchObject({
					status: 503,
					data: { fulfillmentReviewRequired: true }
				});
				expect(mutate).not.toHaveBeenCalled();
			}
		);
		it('uses current stage/balance instead of browser state', async () => {
			for (const change of close
				? ['positive', 'negative', 'closed', 'booked']
				: ['served', 'closed', 'quoted']) {
				const data = projection(close);
				if (change === 'positive' || change === 'negative')
					data.financial.reconciliation.balance = change === 'positive' ? '1.00' : '-1.00';
				else if (change === 'quoted') Object.assign(data, paymentFixture('quoted'));
				else
					data.inquiry.lifecycle.stage =
						change.toUpperCase() as typeof data.inquiry.lifecycle.stage;
				vi.mocked(getStaffRequest).mockResolvedValue({ ok: true, data, setCookies: [] });
				expect(await action(event())).toMatchObject({
					status: 409,
					data: { fulfillmentReviewRequired: true }
				});
			}
			expect(mutate).not.toHaveBeenCalled();
		});
		it.each([403, 404, 409, 400, 422, 500, 503])(
			'safe mutation %s failure blocks repeat without retry',
			async (status) => {
				vi.mocked(mutate).mockResolvedValue(failure(status));
				const result = await action(event());
				expect(result).toMatchObject({
					status: status >= 500 ? 503 : status,
					data: { fulfillmentReviewRequired: true }
				});
				expect(JSON.stringify(result)).not.toContain('PRIVATE');
				if (status >= 500)
					expect(result).toMatchObject({
						data: { fulfillmentError: expect.stringContaining('couldn’t confirm whether') }
					});
				expect(mutate).toHaveBeenCalledOnce();
			}
		);
		it('read failure has distinct safe copy and no attempted mutation', async () => {
			vi.mocked(getStaffRequest).mockResolvedValue(failure(503));
			expect(await action(event())).toMatchObject({
				data: { fulfillmentError: expect.stringContaining('couldn’t review') }
			});
			expect(mutate).not.toHaveBeenCalled();
		});
		it.each(['read', 'mutation'])('redirects 401 at %s', async (stage) => {
			if (stage === 'read') vi.mocked(getStaffRequest).mockResolvedValue(failure(401));
			else vi.mocked(mutate).mockResolvedValue(failure(401));
			await expect(action(event())).rejects.toMatchObject({ status: 303, location: '/login' });
		});
	});
