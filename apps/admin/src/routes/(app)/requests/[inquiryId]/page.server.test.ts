import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actions, load } from './+page.server.js';
import { getStaffRequest, issueQuote } from '$lib/server/staff-request.js';
import { applySetCookies } from '$lib/server/auth.js';
import { mayaId, mayaDocumentId, requestFixtures } from '../../../../../e2e/request-fixture.mjs';

vi.mock('$lib/server/staff-request.js', () => ({ getStaffRequest: vi.fn(), issueQuote: vi.fn() }));
vi.mock('$lib/server/auth.js', () => ({ applySetCookies: vi.fn() }));
vi.mock('$lib/server/config.js', () => ({
	backendConfig: () => ({ baseUrl: 'http://api.test', origin: 'http://admin.test' })
}));

function event(
	entries: Record<string, string> = { expectedVersion: '1' },
	permissions = ['commerce.financial-document.create']
) {
	return {
		params: { inquiryId: mayaId },
		url: new URL(`http://admin.test/requests/${mayaId}?/issueQuote`),
		request: new Request(`http://admin.test/requests/${mayaId}?/issueQuote`, {
			method: 'POST',
			headers: { cookie: 'session=staff' },
			body: new URLSearchParams(entries)
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
	vi.mocked(issueQuote).mockResolvedValue({
		ok: true,
		data: { ...requestFixtures()[mayaId].financial, stage: 'QUOTE', version: 2 },
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
	it('takes the authoritative document id and redirects to a clean GET after success', async () => {
		await expect(actions.issueQuote(event())).rejects.toMatchObject({
			status: 303,
			location: `/requests/${mayaId}`
		});
		expect(getStaffRequest).toHaveBeenCalledOnce();
		expect(issueQuote).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			mayaDocumentId,
			1,
			'session=staff'
		);
		expect(applySetCookies).toHaveBeenCalledWith(expect.anything(), ['session=renewed']);
	});
	it('sends the reviewed version unchanged even when the action read sees a newer Estimate', async () => {
		const data = requestFixtures()[mayaId];
		data.financial.version = 2;
		vi.mocked(getStaffRequest).mockResolvedValue({ ok: true, data, setCookies: [] });
		vi.mocked(issueQuote).mockResolvedValue(backendFailure(409));
		expect(await actions.issueQuote(event())).toMatchObject({
			status: 409,
			data: { reviewRequired: true }
		});
		expect(issueQuote).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			mayaDocumentId,
			1,
			'session=staff'
		);
	});
	it.each(['0', '-1', '1.5', '1e2', '2147483648', ''])(
		'rejects invalid expectedVersion %s without backend reads/mutations',
		async (expectedVersion) => {
			expect(await actions.issueQuote(event({ expectedVersion }))).toMatchObject({ status: 422 });
			expect(getStaffRequest).not.toHaveBeenCalled();
			expect(issueQuote).not.toHaveBeenCalled();
		}
	);
	it('rejects a posted arbitrary document id', async () => {
		expect(
			await actions.issueQuote(event({ expectedVersion: '1', documentId: 'another-document' }))
		).toMatchObject({ status: 422 });
		expect(issueQuote).not.toHaveBeenCalled();
	});
	it('does not proxy a mismatched projection', async () => {
		const data = requestFixtures()[mayaId];
		data.financial.inquiryId = 'another-inquiry';
		vi.mocked(getStaffRequest).mockResolvedValue({ ok: true, data, setCookies: [] });
		expect(await actions.issueQuote(event())).toMatchObject({ status: 503 });
		expect(issueQuote).not.toHaveBeenCalled();
	});
	it('checks permissions again before reading or mutating', async () => {
		expect(await actions.issueQuote(event({ expectedVersion: '1' }, []))).toMatchObject({
			status: 403
		});
		expect(getStaffRequest).not.toHaveBeenCalled();
		expect(issueQuote).not.toHaveBeenCalled();
	});
	it('rejects an ineligible current state rather than issuing another Quote', async () => {
		const data = requestFixtures()[mayaId];
		data.inquiry.lifecycle.stage = 'QUOTED';
		data.financial.stage = 'QUOTE';
		vi.mocked(getStaffRequest).mockResolvedValue({ ok: true, data, setCookies: [] });
		expect(await actions.issueQuote(event())).toMatchObject({ status: 409 });
		expect(issueQuote).not.toHaveBeenCalled();
	});
	it.each([403, 404, 409, 500, 503])(
		'requires review after mutation %i and never exposes diagnostics or retries',
		async (status) => {
			vi.mocked(issueQuote).mockResolvedValue(backendFailure(status));
			const result = await actions.issueQuote(event());
			expect(result).toMatchObject({
				status: status >= 500 ? 503 : status,
				data: { reviewRequired: true }
			});
			expect(JSON.stringify(result)).not.toContain('PRIVATE');
			expect(issueQuote).toHaveBeenCalledOnce();
		}
	);
	it('redirects an expired backend session to login', async () => {
		vi.mocked(getStaffRequest).mockResolvedValue(backendFailure(401));
		await expect(actions.issueQuote(event())).rejects.toMatchObject({
			status: 303,
			location: '/login'
		});
		expect(issueQuote).not.toHaveBeenCalled();
	});
});
