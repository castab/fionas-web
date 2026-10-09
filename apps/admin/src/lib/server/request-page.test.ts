import { beforeEach, it, expect, vi } from 'vitest';
import { requestFixtures, mayaId } from '../../../e2e/request-fixture.mjs';
import { previewQuote } from '../../../e2e/quote-stub.mjs';
import {
	initialQuoteValues,
	buildCommand,
	isQuotePreview,
	type QuoteFormValues
} from '$lib/quote-builder.js';
import { PROPOSAL_PERMISSIONS } from '$lib/request-workspace.js';
import {
	getStaffRequest,
	previewInquiryQuote,
	issueInquiryProposal
} from '$lib/server/staff-request.js';
vi.mock('$lib/server/staff-request.js', () => ({
	getStaffRequest: vi.fn(),
	previewInquiryQuote: vi.fn(),
	issueInquiryProposal: vi.fn(),
	recordPayment: vi.fn(),
	markInquiryServed: vi.fn(),
	closeInquiry: vi.fn()
}));
vi.mock('$lib/server/config.js', () => ({
	backendConfig: () => ({ baseUrl: 'http://api.test', origin: 'https://admin.test' })
}));
import { actions, load } from '../../routes/(app)/requests/[inquiryId]/+page.server.js';
let current = requestFixtures()[mayaId];
function event(
	values = initialQuoteValues(current),
	permissions: string[] = [...PROPOSAL_PERMISSIONS]
) {
	const f = new FormData();
	for (const [k, v] of Object.entries(values.deposit)) f.set(k, v);
	for (const [k, v] of Object.entries({
		planDescription: values.description,
		planGuestCount: values.guestCount,
		planItems: values.items,
		reviewedCurrency: values.reviewedCurrency,
		reviewToken: values.reviewToken,
		reviewedFingerprint: values.reviewedFingerprint
	}))
		f.set(k, v);
	for (const l of values.lines) {
		f.append('lineIdentity', l.lineItemId ? `id:${l.lineItemId}` : `new:${l.key}`);
		for (const k of [
			'description',
			'subDescription',
			'quantity',
			'unitPrice',
			'taxAmount',
			'note'
		] as const)
			f.append(k, l[k] ?? '');
	}
	return {
		params: { inquiryId: mayaId },
		locals: { user: { permissions } },
		url: new URL(`https://admin.test/requests/${mayaId}?quote`),
		request: new Request('https://admin.test', {
			method: 'POST',
			headers: { cookie: '__Host-fionas_session=staff' },
			body: f
		}),
		cookies: { set: vi.fn() },
		setHeaders: vi.fn()
	} as never;
}
beforeEach(() => {
	vi.clearAllMocks();
	current = requestFixtures()[mayaId];
	vi.mocked(getStaffRequest).mockResolvedValue({ ok: true, data: current, setCookies: [] });
	vi.mocked(previewInquiryQuote).mockImplementation(async (_config, _id, body) => {
		const result = previewQuote({ quoteEpoch: 0 }, current, body);
		if (!isQuotePreview(result.body, { inquiryId: mayaId }))
			throw new Error('Invalid test preview');
		return { ok: true, data: result.body, setCookies: [] };
	});
	vi.mocked(issueInquiryProposal).mockResolvedValue({
		ok: true,
		data: {
			proposal: current.proposal!,
			financial: current.financial,
			depositRequirement: current.depositRequirement
		},
		setCookies: []
	});
});
it('previews posted final lines without another read or a public price book', async () => {
	const result = await actions!.previewQuote!(event());
	expect(result).toHaveProperty('preview');
	expect(getStaffRequest).not.toHaveBeenCalled();
	const body = vi.mocked(previewInquiryQuote).mock.calls[0][2];
	expect(body.lines[0].lineItemId).toBe(current.financial.lines[0].id);
	expect(body).not.toHaveProperty('composition');
});
it('opens an authoritative preview with no-store and USER cookie', async () => {
	const e = event() as unknown as { request: Request; setHeaders: ReturnType<typeof vi.fn> };
	e.request = new Request('https://admin.test', {
		headers: { cookie: '__Host-fionas_session=staff' }
	});
	const result = await load(e as never);
	expect(result).toHaveProperty('initialQuote.preview');
	expect(e.setHeaders).toHaveBeenCalledWith({ 'cache-control': 'no-store' });
	expect(vi.mocked(getStaffRequest).mock.calls[0][2]).toBe('__Host-fionas_session=staff');
});
it('issues exactly the previewed final identity-bearing command once, then redirects', async () => {
	const reviewed = (await actions!.previewQuote!(event())) as { quoteValues: QuoteFormValues };
	await expect(actions!.issueQuote!(event(reviewed.quoteValues))).rejects.toMatchObject({
		status: 303,
		location: `/requests/${mayaId}`
	});
	const sent = vi.mocked(issueInquiryProposal).mock.calls[0][5]!;
	expect(sent).toEqual({
		...buildCommand(reviewed.quoteValues),
		reviewToken: reviewed.quoteValues.reviewToken
	});
	expect(issueInquiryProposal).toHaveBeenCalledOnce();
});
it('requires a new click after any edit or stale backend review', async () => {
	const reviewed = (await actions!.previewQuote!(event())) as { quoteValues: QuoteFormValues };
	reviewed.quoteValues.lines[0].unitPrice = '101.00';
	expect(await actions!.issueQuote!(event(reviewed.quoteValues))).toHaveProperty(
		'notices.reviewStale',
		true
	);
	expect(issueInquiryProposal).not.toHaveBeenCalled();
	vi.mocked(issueInquiryProposal).mockResolvedValue({
		ok: false,
		error: { status: 409, code: 'QUOTE_REVIEW_STALE', message: 'private', violations: [] },
		retryAfter: null
	});
	const updated = (await actions!.previewQuote!(event(reviewed.quoteValues))) as {
		quoteValues: QuoteFormValues;
	};
	expect(await actions!.issueQuote!(event(updated.quoteValues))).toHaveProperty(
		'notices.reviewStale',
		true
	);
	expect(issueInquiryProposal).toHaveBeenCalledOnce();
});
it.each([403, 409, 500])('never retries a %i issuance and requires reload', async (status) => {
	const reviewed = (await actions!.previewQuote!(event())) as { quoteValues: QuoteFormValues };
	vi.mocked(issueInquiryProposal).mockResolvedValue({
		ok: false,
		error: { status, code: 'failure', message: 'private', violations: [] },
		retryAfter: null
	});
	const result = await actions!.issueQuote!(event(reviewed.quoteValues));
	expect(result).toHaveProperty('data.reviewRequired', true);
	expect(issueInquiryProposal).toHaveBeenCalledOnce();
	expect(JSON.stringify(result)).not.toContain('private');
});
it('requires all three permissions and never substitutes a newer reviewed version', async () => {
	await actions!.previewQuote!(event(undefined, PROPOSAL_PERMISSIONS.slice(0, 2)));
	expect(previewInquiryQuote).not.toHaveBeenCalled();
	const values = initialQuoteValues(current);
	current.financial.version++;
	expect(await actions!.issueQuote!(event(values))).toHaveProperty('status', 409);
	expect(issueInquiryProposal).not.toHaveBeenCalled();
});
it('validates as USD whatever the browser posts, refusing other currencies before preview', async () => {
	const values = { ...initialQuoteValues(current), reviewedCurrency: 'EUR' } as never;
	expect(await actions!.previewQuote!(event(values))).toHaveProperty('status', 422);
	expect(previewInquiryQuote).not.toHaveBeenCalled();
});
it('refuses to quote a non-USD document: no opening preview and no issuance', async () => {
	const reviewed = (await actions!.previewQuote!(event())) as { quoteValues: QuoteFormValues };
	vi.mocked(previewInquiryQuote).mockClear();
	// A coherent document in another currency, as a generic Commerce could return it.
	current = JSON.parse(JSON.stringify(current).replaceAll('"USD"', '"EUR"'));
	vi.mocked(getStaffRequest).mockResolvedValue({ ok: true, data: current, setCookies: [] });
	const e = event() as unknown as { request: Request };
	e.request = new Request('https://admin.test', {
		headers: { cookie: '__Host-fionas_session=staff' }
	});
	expect(await load(e as never)).toHaveProperty('initialQuote', null);
	expect(previewInquiryQuote).not.toHaveBeenCalled();
	expect(await actions!.issueQuote!(event(reviewed.quoteValues))).toHaveProperty('status', 409);
	expect(issueInquiryProposal).not.toHaveBeenCalled();
});
it('refuses a preview that comes back in another currency', async () => {
	vi.mocked(previewInquiryQuote).mockImplementationOnce(async (_config, _id, body) => {
		const result = previewQuote({ quoteEpoch: 0 }, current, body);
		return { ok: true, data: { ...result.body, currency: 'EUR' } as never, setCookies: [] };
	});
	expect(await actions!.previewQuote!(event())).toHaveProperty('status', 503);
});
