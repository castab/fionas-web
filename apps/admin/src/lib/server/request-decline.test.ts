import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actions } from '../../routes/(app)/requests/[inquiryId]/+page.server.js';
import { declineInquiry, getStaffRequest } from '$lib/server/staff-request.js';
import { applySetCookies } from '$lib/server/auth.js';
import { INQUIRY_MANAGE_PERMISSION, PROPOSAL_PERMISSIONS } from '$lib/request-workspace.js';
import { PAYMENT_PERMISSION } from '$lib/payments.js';
import { DECLINE_REASON_MAX } from '$lib/decline.js';
import { declinedFixture, mayaId, requestFixtures } from '../../../e2e/request-fixture.mjs';

vi.mock('$lib/server/staff-request.js', () => ({
	getStaffRequest: vi.fn(),
	declineInquiry: vi.fn(),
	markInquiryServed: vi.fn(),
	closeInquiry: vi.fn(),
	recordPayment: vi.fn(),
	issueInquiryProposal: vi.fn(),
	previewInquiryQuote: vi.fn()
}));
vi.mock('$lib/server/auth.js', () => ({ applySetCookies: vi.fn() }));
vi.mock('$lib/server/config.js', () => ({
	backendConfig: () => ({ baseUrl: 'http://api.test', origin: 'http://admin.test' })
}));

const action = actions.declineInquiry;
function body(
	entries: [string, string][] = [
		['expectedDocumentVersion', '1'],
		['reason', '  Requested date is unavailable.  ']
	]
) {
	const form = new FormData();
	for (const [key, value] of entries) form.append(key, value);
	return form;
}
function event(permissions: string[] = [INQUIRY_MANAGE_PERMISSION], form: BodyInit = body()) {
	return {
		params: { inquiryId: mayaId },
		url: new URL(`http://admin.test/requests/${mayaId}?/declineInquiry`),
		request: new Request('http://admin.test', {
			method: 'POST',
			headers: { cookie: 'session=staff' },
			body: form
		}),
		locals: { user: { id: 'staff', roles: ['commerce.administrator'], permissions } },
		cookies: {}
	} as unknown as Parameters<typeof action>[0];
}
function failure(status: number) {
	return {
		ok: false as const,
		error: { status, code: 'failure', message: 'PRIVATE diagnostic', violations: [] },
		retryAfter: null
	};
}
function requested(version = 1) {
	const data = requestFixtures()[mayaId];
	data.financial.version = version;
	return data;
}
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getStaffRequest).mockResolvedValue({
		ok: true,
		data: requested(),
		setCookies: ['session=read']
	});
	vi.mocked(declineInquiry).mockResolvedValue({
		ok: true,
		data: declinedFixture().inquiry.lifecycle,
		setCookies: ['session=renewed']
	});
});

describe('decline action', () => {
	it('re-reads, declines once with exactly the reviewed version and trimmed reason, then PRGs', async () => {
		await expect(action(event())).rejects.toMatchObject({
			status: 303,
			location: `/requests/${mayaId}`
		});
		expect(getStaffRequest).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			mayaId,
			'session=staff'
		);
		expect(declineInquiry).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			mayaId,
			{ expectedDocumentVersion: 1, reason: 'Requested date is unavailable.' },
			'session=staff'
		);
		// Nothing else is forwarded: no actor, time, stage or browser identity.
		expect(Object.keys(vi.mocked(declineInquiry).mock.calls[0][2]).sort()).toEqual([
			'expectedDocumentVersion',
			'reason'
		]);
		expect(vi.mocked(getStaffRequest).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(declineInquiry).mock.invocationCallOrder[0]
		);
		expect(applySetCookies).toHaveBeenCalledWith(expect.anything(), ['session=read']);
		expect(applySetCookies).toHaveBeenCalledWith(expect.anything(), ['session=renewed']);
	});
	it('sends a later reviewed Estimate version and keeps internal line breaks', async () => {
		vi.mocked(getStaffRequest).mockResolvedValue({ ok: true, data: requested(4), setCookies: [] });
		await expect(
			action(
				event(
					undefined,
					body([
						['expectedDocumentVersion', '4'],
						['reason', 'Date taken.\r\nOffered Nov 21.']
					])
				)
			)
		).rejects.toMatchObject({ status: 303 });
		expect(vi.mocked(declineInquiry).mock.calls[0][2]).toEqual({
			expectedDocumentVersion: 4,
			reason: 'Date taken.\nOffered Nov 21.'
		});
	});
	it('needs a session and fionas.inquiries.manage before any backend access', async () => {
		for (const permissions of [[], [...PROPOSAL_PERMISSIONS, PAYMENT_PERMISSION]])
			expect(await action(event(permissions))).toMatchObject({
				status: 403,
				data: { declineReviewRequired: true }
			});
		const signedOut = event();
		signedOut.locals.user = null;
		await expect(action(signedOut)).rejects.toMatchObject({ status: 303, location: '/login' });
		expect(getStaffRequest).not.toHaveBeenCalled();
		expect(declineInquiry).not.toHaveBeenCalled();
	});
	it('does not need the Quote permissions', async () => {
		await expect(action(event([INQUIRY_MANAGE_PERMISSION]))).rejects.toMatchObject({
			status: 303
		});
		expect(declineInquiry).toHaveBeenCalledOnce();
	});
	it.each([
		['blank', ''],
		['whitespace', ' \r\n\t '],
		['overlong', 'x'.repeat(DECLINE_REASON_MAX + 1)]
	])('rejects a %s reason locally, keeping it for correction', async (_, reason) => {
		const result = await action(
			event(
				undefined,
				body([
					['expectedDocumentVersion', '1'],
					['reason', reason]
				])
			)
		);
		expect(result).toMatchObject({
			status: 422,
			data: {
				declineReviewRequired: false,
				declineField: 'reason',
				declineValues: { reason, expectedDocumentVersion: '1' }
			}
		});
		expect(getStaffRequest).not.toHaveBeenCalled();
		expect(declineInquiry).not.toHaveBeenCalled();
	});
	it.each([
		[
			'duplicated reason',
			[...[['expectedDocumentVersion', '1']], ['reason', 'a'], ['reason', 'b']]
		],
		[
			'duplicated version',
			[
				['expectedDocumentVersion', '1'],
				['expectedDocumentVersion', '2'],
				['reason', 'a']
			]
		],
		[
			'inquiry id',
			[
				['expectedDocumentVersion', '1'],
				['reason', 'a'],
				['inquiryId', 'other']
			]
		],
		[
			'actor',
			[
				['expectedDocumentVersion', '1'],
				['reason', 'a'],
				['principalId', 'staff']
			]
		],
		[
			'timestamp',
			[
				['expectedDocumentVersion', '1'],
				['reason', 'a'],
				['occurredAt', 'now']
			]
		],
		[
			'stage',
			[
				['expectedDocumentVersion', '1'],
				['reason', 'a'],
				['stage', 'DECLINED']
			]
		],
		[
			'amount',
			[
				['expectedDocumentVersion', '1'],
				['reason', 'a'],
				['amount', '0']
			]
		],
		['missing version', [['reason', 'a']]],
		[
			'bad version',
			[
				['expectedDocumentVersion', 'latest'],
				['reason', 'a']
			]
		]
	] as [string, [string, string][]][])('rejects %s before backend access', async (_, entries) => {
		expect(await action(event(undefined, body(entries)))).toMatchObject({
			status: 400,
			data: { declineReviewRequired: true }
		});
		expect(getStaffRequest).not.toHaveBeenCalled();
		expect(declineInquiry).not.toHaveBeenCalled();
	});
	it('rejects an unreadable body', async () => {
		expect(await action(event(undefined, 'unreadable'))).toMatchObject({ status: 400 });
		expect(declineInquiry).not.toHaveBeenCalled();
	});
	it('never replaces a stale reviewed version with the freshly read one', async () => {
		vi.mocked(getStaffRequest).mockResolvedValue({ ok: true, data: requested(2), setCookies: [] });
		const result = await action(event());
		expect(result).toMatchObject({
			status: 409,
			data: { declineReviewRequired: true, declineValues: { expectedDocumentVersion: '1' } }
		});
		expect(declineInquiry).not.toHaveBeenCalled();
	});
	it.each(['quoted', 'declined', 'incoherent'])(
		'refuses a %s current state before mutation',
		async (kind) => {
			const data =
				kind === 'quoted'
					? requestFixtures()['00000000-0000-0000-0000-000000000001']
					: kind === 'declined'
						? declinedFixture()
						: requested();
			if (kind === 'quoted') data.inquiry.id = mayaId;
			if (kind === 'incoherent') data.inquiry.lifecycle.documentId = 'other';
			vi.mocked(getStaffRequest).mockResolvedValue({ ok: true, data, setCookies: [] });
			const result = await action(event());
			expect(result).toMatchObject({ data: { declineReviewRequired: true } });
			expect([409, 503]).toContain((result as { status: number }).status);
			expect(declineInquiry).not.toHaveBeenCalled();
		}
	);
	it('a failed pre-mutation read says nothing was declined', async () => {
		vi.mocked(getStaffRequest).mockResolvedValue(failure(503));
		expect(await action(event())).toMatchObject({
			status: 503,
			data: {
				declineReviewRequired: true,
				declineError: expect.stringContaining('Nothing was declined')
			}
		});
		expect(declineInquiry).not.toHaveBeenCalled();
	});
	it('keeps a backend validation refusal correctable', async () => {
		vi.mocked(declineInquiry).mockResolvedValue(failure(422));
		const result = await action(event());
		expect(result).toMatchObject({
			status: 422,
			data: { declineReviewRequired: false, declineValues: { expectedDocumentVersion: '1' } }
		});
		expect(declineInquiry).toHaveBeenCalledOnce();
	});
	it.each([400, 403, 404, 409, 500, 502, 503])(
		'backend %s after the attempt requires review and is never retried',
		async (status) => {
			vi.mocked(declineInquiry).mockResolvedValue(failure(status));
			const result = await action(event());
			expect(result).toMatchObject({
				status: status >= 500 ? 503 : status,
				data: { declineReviewRequired: true }
			});
			if (status >= 500)
				expect(result).toMatchObject({
					data: {
						declineError:
							'We couldn’t confirm whether this request was declined. Reload to review its latest status before taking another action.'
					}
				});
			expect(JSON.stringify(result)).not.toContain('PRIVATE');
			expect(declineInquiry).toHaveBeenCalledOnce();
		}
	);
	it.each(['read', 'mutation'])('redirects a 401 at %s to sign in', async (stage) => {
		if (stage === 'read') vi.mocked(getStaffRequest).mockResolvedValue(failure(401));
		else vi.mocked(declineInquiry).mockResolvedValue(failure(401));
		await expect(action(event())).rejects.toMatchObject({ status: 303, location: '/login' });
	});
});
