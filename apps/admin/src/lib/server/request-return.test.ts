import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actions, load } from '../../routes/(app)/requests/[inquiryId]/+page.server.js';
import {
	declineInquiry,
	getStaffRequest,
	markInquiryServed,
	recordPayment
} from '$lib/server/staff-request.js';
import { INQUIRY_MANAGE_PERMISSION } from '$lib/request-workspace.js';
import { workspaceAction, workspaceSearch, type RequestListQuery } from '$lib/request-list.js';
import { mayaId, paymentFixture, requestFixtures } from '../../../e2e/request-fixture.mjs';

vi.mock('$lib/server/staff-request.js', () => ({
	getStaffRequest: vi.fn(),
	markInquiryServed: vi.fn(),
	closeInquiry: vi.fn(),
	recordPayment: vi.fn(),
	declineInquiry: vi.fn(),
	issueInquiryProposal: vi.fn(),
	previewInquiryQuote: vi.fn()
}));
vi.mock('$lib/server/auth.js', () => ({ applySetCookies: vi.fn() }));
vi.mock('$lib/server/config.js', () => ({
	backendConfig: () => ({ baseUrl: 'http://api.test', origin: 'http://admin.test' })
}));

const context: RequestListQuery = { filter: 'quoted', q: 'maria', cursor: 'page-2/token+=' };
const path = `/requests/${mayaId}`;
const permissions = [INQUIRY_MANAGE_PERMISSION, 'commerce.payment.record'];

function event(search: string, body?: FormData) {
	return {
		params: { inquiryId: mayaId },
		url: new URL(`http://admin.test${path}${search}`),
		request: new Request(`http://admin.test${path}${search}`, {
			method: body ? 'POST' : 'GET',
			headers: { cookie: 'session=staff' },
			body
		}),
		locals: { user: { id: 'staff', roles: [], permissions } },
		cookies: {},
		setHeaders: vi.fn()
	} as never;
}
const ok = <T>(data: T) => ({ ok: true as const, data, setCookies: [] });

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(markInquiryServed).mockResolvedValue(ok({ documentId: 'x', stage: 'SERVED' }));
	vi.mocked(declineInquiry).mockResolvedValue(ok({ documentId: 'x', stage: 'DECLINED' }));
	vi.mocked(recordPayment).mockResolvedValue(ok({}) as never);
});

describe('workspace return context', () => {
	it('loads a validated Requests context beside the panel flags', async () => {
		vi.mocked(getStaffRequest).mockResolvedValue(ok(requestFixtures()[mayaId]));
		const result = (await load(event(workspaceSearch(context, 'decline')))) as Record<
			string,
			unknown
		>;
		expect(result).toMatchObject({ returnContext: context, declineOpen: true, quoteOpen: false });
		const plain = (await load(event(''))) as Record<string, unknown>;
		expect(plain.returnContext).toBeNull();
	});
	it.each([
		'?from=https%3A%2F%2Fevil.example',
		'?from=%2F%2Fevil.example',
		'?from=%2Flogout',
		`?from=${encodeURIComponent('filter=quoted&next=https://evil.example')}`
	])('ignores an untrusted return destination %s', async (search) => {
		vi.mocked(getStaffRequest).mockResolvedValue(ok(requestFixtures()[mayaId]));
		const result = (await load(event(search))) as Record<string, unknown>;
		expect(result.returnContext).toBeNull();
	});
	it('keeps the context on an unavailable workspace too', async () => {
		vi.mocked(getStaffRequest).mockResolvedValue({
			ok: false,
			retryAfter: null,
			error: { status: 500, code: 'failure', message: 'PRIVATE', violations: [] }
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = (await load(event(workspaceSearch(context)))) as Record<string, unknown>;
		expect(result).toMatchObject({ staffRequest: null, returnContext: context });
	});
	it('PRGs a fulfillment action back to the clean path with its context', async () => {
		vi.mocked(getStaffRequest).mockResolvedValue(ok(paymentFixture('booked')));
		await expect(
			actions.markServed(event(workspaceAction(context, 'markServed'), new FormData()))
		).rejects.toMatchObject({ status: 303, location: `${path}${workspaceSearch(context)}` });
		expect(markInquiryServed).toHaveBeenCalledOnce();
	});
	it('PRGs a payment action back with its context, closing the panel', async () => {
		vi.mocked(getStaffRequest).mockResolvedValue(ok(paymentFixture('booked')));
		const request = paymentFixture('booked');
		const form = new FormData();
		form.set('expectedVersion', String(request.financial.version));
		form.set('method', 'CASH');
		form.set('amount', '50.00');
		await expect(
			actions.recordInvoicePayment(event(workspaceAction(context, 'recordInvoicePayment'), form))
		).rejects.toMatchObject({ status: 303, location: `${path}${workspaceSearch(context)}` });
		expect(recordPayment).toHaveBeenCalledOnce();
	});
	it('PRGs a decline back with its context, and without one to the plain path', async () => {
		vi.mocked(getStaffRequest).mockResolvedValue(ok(requestFixtures()[mayaId]));
		const form = () => {
			const f = new FormData();
			f.set('expectedDocumentVersion', '1');
			f.set('reason', 'Date unavailable.');
			return f;
		};
		await expect(
			actions.declineInquiry(event(workspaceAction(context, 'declineInquiry', 'decline'), form()))
		).rejects.toMatchObject({ location: `${path}${workspaceSearch(context)}` });
		await expect(
			actions.declineInquiry(event(workspaceAction(null, 'declineInquiry'), form()))
		).rejects.toMatchObject({ location: path });
		await expect(
			actions.declineInquiry(event('?from=%2F%2Fevil.example&/declineInquiry', form()))
		).rejects.toMatchObject({ location: path });
	});
});
