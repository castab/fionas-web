import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actions, load } from './+page.server.js';
import { getStaffRequest, issueInquiryProposal } from '$lib/server/staff-request.js';
import { applySetCookies } from '$lib/server/auth.js';
import { mayaId, requestFixtures } from '../../../../../e2e/request-fixture.mjs';

vi.mock('$lib/server/staff-request.js', () => ({
	markInquiryServed: vi.fn(),
	closeInquiry: vi.fn(),
	getStaffRequest: vi.fn(),
	issueInquiryProposal: vi.fn()
}));
vi.mock('$lib/server/auth.js', () => ({ applySetCookies: vi.fn() }));
vi.mock('$lib/server/config.js', () => ({
	backendConfig: () => ({ baseUrl: 'http://api.test', origin: 'http://admin.test' })
}));

function event(
	entries: Record<string, string> = { expectedVersion: '1' },
	permissions = ['commerce.financial-document.create', 'commerce.deposit-requirement.manage']
) {
	return {
		params: { inquiryId: mayaId },
		url: new URL(`http://admin.test/requests/${mayaId}?/issueProposal`),
		request: new Request(`http://admin.test/requests/${mayaId}?/issueProposal`, {
			method: 'POST',
			headers: { cookie: 'session=staff' },
			body: new URLSearchParams({
				depositChoice: 'suggested',
				reviewedSuggestionType: 'PERCENTAGE',
				reviewedSuggestionValue: '20',
				...entries
			})
		}),
		locals: {
			user: { id: 'staff', username: 'staff', displayName: 'Staff', roles: [], permissions }
		},
		cookies: {},
		setHeaders: vi.fn()
	} as unknown as Parameters<typeof load>[0];
}

function backendFailure(status: number) {
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
		data: requestFixtures()[mayaId],
		setCookies: []
	});
	vi.mocked(issueInquiryProposal).mockResolvedValue({
		ok: true,
		data: {
			financial: { ...requestFixtures()[mayaId].financial, stage: 'QUOTE', version: 2 },
			proposal: requestFixtures()['00000000-0000-0000-0000-000000000001'].proposal!,
			depositRequirement:
				requestFixtures()['00000000-0000-0000-0000-000000000001'].depositRequirement
		},
		setCookies: ['session=renewed']
	});
});

describe('request route load', () => {
	it('reads one coherent projection with no-store and USER forwarding', async () => {
		const requestEvent = event();
		const result = await load(requestEvent);
		expect(requestEvent.setHeaders).toHaveBeenCalledWith({ 'cache-control': 'no-store' });
		expect(getStaffRequest).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			mayaId,
			'session=staff'
		);
		expect(result).toMatchObject({ staffRequest: { inquiry: { id: mayaId } }, requestError: null });
	});
	it.each([
		[403, 'forbidden'],
		[404, 'not-found'],
		[500, 'unavailable']
	] as const)('safely maps a %i read failure', async (status, requestError) => {
		vi.mocked(getStaffRequest).mockResolvedValue(backendFailure(status));
		expect(await load(event())).toMatchObject({ staffRequest: null, requestError });
	});
	it('refuses a projection without current reconciliation', async () => {
		const data = requestFixtures()[mayaId];
		vi.mocked(getStaffRequest).mockResolvedValue({
			ok: true,
			data: { ...data, financial: { ...data.financial, reconciliation: undefined } },
			setCookies: []
		});
		expect(await load(event())).toMatchObject({ staffRequest: null, requestError: 'unavailable' });
	});
});

describe('Issue Quote action', () => {
	it.each([
		{ permissions: [] },
		{ permissions: ['commerce.financial-document.create'] },
		{ permissions: ['commerce.deposit-requirement.manage'] }
	])(
		'denies incomplete permissions $permissions before backend access',
		async ({ permissions }) => {
			expect(
				await actions.issueProposal(event({ expectedVersion: '1' }, permissions))
			).toMatchObject({ status: 403 });
			expect(getStaffRequest).not.toHaveBeenCalled();
			expect(issueInquiryProposal).not.toHaveBeenCalled();
		}
	);
	it.each([
		{
			depositChoice: 'percentage',
			depositPercentage: '017.500',
			terms: { type: 'PERCENTAGE', percentage: '017.500' }
		},
		{
			depositChoice: 'fixed',
			depositAmount: '123.400',
			terms: { type: 'FIXED', amount: '123.400', currency: 'CAD' }
		}
	])(
		'preserves $depositChoice strings and uses authoritative currency',
		async ({ terms, ...fields }) => {
			const data = requestFixtures()[mayaId];
			data.financial.currency = 'CAD';
			data.financial.reconciliation.currency = 'CAD';
			vi.mocked(getStaffRequest).mockResolvedValue({
				ok: true,
				data,
				setCookies: ['session=read-renewed']
			});
			await expect(
				actions.issueProposal(
					event({
						expectedVersion: '1',
						depositChoice: fields.depositChoice,
						depositPercentage: fields.depositPercentage ?? '',
						depositAmount: fields.depositAmount ?? ''
					})
				)
			).rejects.toMatchObject({ status: 303 });
			expect(getStaffRequest).toHaveBeenCalledOnce();
			expect(issueInquiryProposal).toHaveBeenCalledExactlyOnceWith(
				expect.anything(),
				mayaId,
				1,
				terms,
				'session=staff'
			);
			expect(applySetCookies).toHaveBeenCalledWith(expect.anything(), ['session=read-renewed']);
		}
	);
	it.each(['0', '101', '1e2', '-1', 'NaN', '1,5', '100.0000000000000001'])(
		'allows correction of invalid percentage %s before backend access',
		async (depositPercentage) => {
			const result = await actions.issueProposal(
				event({ expectedVersion: '1', depositChoice: 'percentage', depositPercentage })
			);
			expect(result).toMatchObject({
				status: 422,
				data: {
					reviewRequired: false,
					depositErrorField: 'depositPercentage',
					values: { expectedVersion: '1', depositPercentage }
				}
			});
			expect(getStaffRequest).not.toHaveBeenCalled();
			expect(issueInquiryProposal).not.toHaveBeenCalled();
		}
	);
	it('rejects duplicate fields and browser currency without a mutation', async () => {
		const duplicate = event();
		duplicate.request = new Request(duplicate.url, {
			method: 'POST',
			body: 'expectedVersion=1&expectedVersion=2&depositChoice=suggested&reviewedSuggestionType=PERCENTAGE&reviewedSuggestionValue=20',
			headers: { 'content-type': 'application/x-www-form-urlencoded' }
		});
		expect(await actions.issueProposal(duplicate)).toMatchObject({
			status: 422,
			data: { reviewRequired: true }
		});
		expect(
			await actions.issueProposal(event({ expectedVersion: '1', currency: 'USD' }))
		).toMatchObject({ status: 422 });
		expect(getStaffRequest).not.toHaveBeenCalled();
	});
	it('requires review of a changed suggestion instead of substituting it', async () => {
		const data = requestFixtures()[mayaId];
		data.suggestedDepositTerms = { type: 'PERCENTAGE', percentage: '25' };
		vi.mocked(getStaffRequest).mockResolvedValue({ ok: true, data, setCookies: [] });
		expect(await actions.issueProposal(event())).toMatchObject({
			status: 409,
			data: { reviewRequired: true }
		});
		expect(issueInquiryProposal).not.toHaveBeenCalled();
	});
	it('issues an explicit fixed backend suggestion', async () => {
		const data = requestFixtures()[mayaId];
		data.suggestedDepositTerms = { type: 'FIXED', amount: '120.00', currency: 'USD' };
		vi.mocked(getStaffRequest).mockResolvedValue({ ok: true, data, setCookies: [] });
		await expect(
			actions.issueProposal(
				event({
					expectedVersion: '1',
					reviewedSuggestionType: 'FIXED',
					reviewedSuggestionValue: '120.00'
				})
			)
		).rejects.toMatchObject({ status: 303 });
		expect(issueInquiryProposal).toHaveBeenCalledWith(
			expect.anything(),
			mayaId,
			1,
			data.suggestedDepositTerms,
			'session=staff'
		);
	});
	it.each([400, 422])('retains reviewed values for correction after backend %i', async (status) => {
		vi.mocked(issueInquiryProposal).mockResolvedValue(backendFailure(status));
		expect(
			await actions.issueProposal(
				event({ expectedVersion: '1', depositChoice: 'fixed', depositAmount: '123.001' })
			)
		).toMatchObject({
			status,
			data: {
				reviewRequired: false,
				depositErrorField: 'depositAmount',
				values: { expectedVersion: '1', depositAmount: '123.001', reviewedSuggestionValue: '20' }
			}
		});
		expect(issueInquiryProposal).toHaveBeenCalledOnce();
	});
	it('redirects 401s from load and mutation without retry', async () => {
		vi.mocked(issueInquiryProposal).mockResolvedValue(backendFailure(401));
		await expect(actions.issueProposal(event())).rejects.toMatchObject({
			status: 303,
			location: '/login'
		});
		expect(issueInquiryProposal).toHaveBeenCalledOnce();
		vi.mocked(getStaffRequest).mockResolvedValue(backendFailure(401));
		await expect(load(event())).rejects.toMatchObject({ status: 303, location: '/login' });
	});
	it('takes the route inquiry id and redirects to a clean GET after success', async () => {
		await expect(actions.issueProposal(event())).rejects.toMatchObject({
			status: 303,
			location: `/requests/${mayaId}`
		});
		expect(getStaffRequest).toHaveBeenCalledOnce();
		expect(issueInquiryProposal).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			mayaId,
			1,
			{ type: 'PERCENTAGE', percentage: '20' },
			'session=staff'
		);
		expect(applySetCookies).toHaveBeenCalledWith(expect.anything(), ['session=renewed']);
	});
	it('sends the reviewed version unchanged even when the action read sees a newer Estimate', async () => {
		const data = requestFixtures()[mayaId];
		data.financial.version = 2;
		vi.mocked(getStaffRequest).mockResolvedValue({ ok: true, data, setCookies: [] });
		vi.mocked(issueInquiryProposal).mockResolvedValue(backendFailure(409));
		expect(await actions.issueProposal(event())).toMatchObject({
			status: 409,
			data: { reviewRequired: true }
		});
		expect(issueInquiryProposal).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			mayaId,
			1,
			{ type: 'PERCENTAGE', percentage: '20' },
			'session=staff'
		);
	});
	it.each(['0', '-1', '1.5', '1e2', '2147483648', ''])(
		'rejects invalid expectedVersion %s without backend reads/mutations',
		async (expectedVersion) => {
			expect(await actions.issueProposal(event({ expectedVersion }))).toMatchObject({
				status: 422
			});
			expect(getStaffRequest).not.toHaveBeenCalled();
			expect(issueInquiryProposal).not.toHaveBeenCalled();
		}
	);
	it('rejects a posted arbitrary document id', async () => {
		expect(
			await actions.issueProposal(event({ expectedVersion: '1', documentId: 'another-document' }))
		).toMatchObject({ status: 422 });
		expect(issueInquiryProposal).not.toHaveBeenCalled();
	});
	it('does not proxy a mismatched projection', async () => {
		const data = requestFixtures()[mayaId];
		data.financial.inquiryId = 'another-inquiry';
		vi.mocked(getStaffRequest).mockResolvedValue({ ok: true, data, setCookies: [] });
		expect(await actions.issueProposal(event())).toMatchObject({ status: 503 });
		expect(issueInquiryProposal).not.toHaveBeenCalled();
	});
	it('checks permissions again before reading or mutating', async () => {
		expect(await actions.issueProposal(event({ expectedVersion: '1' }, []))).toMatchObject({
			status: 403
		});
		expect(getStaffRequest).not.toHaveBeenCalled();
		expect(issueInquiryProposal).not.toHaveBeenCalled();
	});
	it('rejects an ineligible current state rather than issuing another Quote', async () => {
		const data = requestFixtures()[mayaId];
		data.inquiry.lifecycle.stage = 'QUOTED';
		data.financial.stage = 'QUOTE';
		data.financial.version = 2;
		const quoted = requestFixtures()['00000000-0000-0000-0000-000000000001'];
		data.proposal = { ...quoted.proposal!, inquiryId: mayaId, documentId: data.financial.id };
		data.depositRequirement = { ...quoted.depositRequirement, documentId: data.financial.id };
		vi.mocked(getStaffRequest).mockResolvedValue({ ok: true, data, setCookies: [] });
		expect(await actions.issueProposal(event())).toMatchObject({ status: 409 });
		expect(issueInquiryProposal).not.toHaveBeenCalled();
	});
	it.each([403, 404, 409, 500, 503])(
		'requires review after mutation %i and never exposes diagnostics or retries',
		async (status) => {
			vi.mocked(issueInquiryProposal).mockResolvedValue(backendFailure(status));
			const result = await actions.issueProposal(event());
			expect(result).toMatchObject({
				status: status >= 500 ? 503 : status,
				data: { reviewRequired: true }
			});
			expect(JSON.stringify(result)).not.toContain('PRIVATE');
			expect(issueInquiryProposal).toHaveBeenCalledOnce();
		}
	);
	it('redirects an expired backend session to login', async () => {
		vi.mocked(getStaffRequest).mockResolvedValue(backendFailure(401));
		await expect(actions.issueProposal(event())).rejects.toMatchObject({
			status: 303,
			location: '/login'
		});
		expect(issueInquiryProposal).not.toHaveBeenCalled();
	});
});
