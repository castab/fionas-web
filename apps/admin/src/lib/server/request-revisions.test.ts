import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	getDepositRequirementHistory,
	getFinancialDocumentHistory,
	getStaffRequest,
	previewInquiryInvoiceRevision,
	previewInquiryQuote,
	previewInquiryQuoteRevision,
	reviseInquiryInvoice,
	reviseInquiryQuote
} from '$lib/server/staff-request.js';
vi.mock('$lib/server/staff-request.js', () => ({
	getStaffRequest: vi.fn(),
	previewInquiryQuote: vi.fn(),
	issueInquiryProposal: vi.fn(),
	previewInquiryQuoteRevision: vi.fn(),
	reviseInquiryQuote: vi.fn(),
	previewInquiryInvoiceRevision: vi.fn(),
	reviseInquiryInvoice: vi.fn(),
	getFinancialDocumentHistory: vi.fn(),
	getDepositRequirementHistory: vi.fn(),
	recordPayment: vi.fn(),
	markInquiryServed: vi.fn(),
	closeInquiry: vi.fn(),
	declineInquiry: vi.fn()
}));
vi.mock('$lib/server/config.js', () => ({
	backendConfig: () => ({ baseUrl: 'http://api.test', origin: 'https://admin.test' })
}));
import { actions, load } from '../../routes/(app)/requests/[inquiryId]/+page.server.js';
import { editorValues, type QuoteFormValues } from '$lib/quote-builder.js';
import { INVOICE_AMENDMENT_PERMISSIONS, PROPOSAL_PERMISSIONS } from '$lib/request-workspace.js';
import { postedForm } from '$lib/revision-form.testing.js';
import {
	applyInvoiceRevision,
	applyQuoteRevision,
	ensureHistory,
	previewInvoiceRevision,
	previewQuoteRevision
} from '../../../e2e/revision-stub.mjs';
import { revisionFixture, type RevisionState } from '../../../e2e/revision-fixture.mjs';
import type { CurrentStaffRequest } from '$lib/request-contract.js';

const inquiryId = '00000000-0000-0000-0000-000000000003';
let current: CurrentStaffRequest;
const invoicePermissions = [...INVOICE_AMENDMENT_PERMISSIONS];
const quotePermissions = [...PROPOSAL_PERMISSIONS];

function event(
	values: QuoteFormValues,
	{
		permissions = quotePermissions,
		search = '?quote-revision',
		extra = {}
	}: { permissions?: string[]; search?: string; extra?: Record<string, string> } = {}
) {
	return {
		params: { inquiryId },
		locals: { user: { permissions } },
		url: new URL(`https://admin.test/requests/${inquiryId}${search}`),
		request: new Request('https://admin.test', {
			method: 'POST',
			headers: { cookie: '__Host-fionas_session=staff' },
			body: postedForm(values, extra)
		}),
		cookies: { set: vi.fn() },
		setHeaders: vi.fn()
	} as never;
}
function pageEvent(search: string, permissions = quotePermissions) {
	return {
		params: { inquiryId },
		locals: { user: { permissions } },
		url: new URL(`https://admin.test/requests/${inquiryId}${search}`),
		request: new Request('https://admin.test', {
			headers: { cookie: '__Host-fionas_session=staff' }
		}),
		cookies: { set: vi.fn() },
		setHeaders: vi.fn()
	} as never;
}
const backend = vi.mocked;
const body = (call: unknown[], index = 2) => call[index] as Record<string, unknown>;

function useState(state: RevisionState) {
	current = revisionFixture(state);
	backend(getStaffRequest).mockImplementation(async () => ({
		ok: true,
		data: structuredClone(current),
		setCookies: []
	}));
}
beforeEach(() => {
	vi.clearAllMocks();
	useState('quoted');
	backend(previewInquiryQuoteRevision).mockImplementation(async (_c, _id, json) => {
		const result = previewQuoteRevision({ quoteEpoch: 0 }, current, json);
		return result.status === 200
			? { ok: true, data: result.body, setCookies: [] }
			: {
					ok: false,
					retryAfter: null,
					error: {
						status: result.status,
						code: result.body.code,
						message: '',
						violations: (result.body.violations ?? []).map((v: { code: string }) => v.code)
					}
				};
	});
	backend(previewInquiryInvoiceRevision).mockImplementation(async (_c, _id, json) => {
		const result = previewInvoiceRevision({ quoteEpoch: 0 }, current, json);
		return result.status === 200
			? { ok: true, data: result.body, setCookies: [] }
			: {
					ok: false,
					retryAfter: null,
					error: {
						status: result.status,
						code: result.body.code,
						message: '',
						violations: (result.body.violations ?? []).map((v: { code: string }) => v.code)
					}
				};
	});
	backend(reviseInquiryQuote).mockImplementation(async (_c, _id, json) => {
		const { reviewToken, ...rest } = json;
		void reviewToken;
		const reviewed = previewQuoteRevision({ quoteEpoch: 0 }, current, rest);
		applyQuoteRevision(current, reviewed.body, rest, '00000000-0000-0000-0000-000000000001');
		return { ok: true, data: {} as never, setCookies: [] };
	});
	backend(reviseInquiryInvoice).mockImplementation(async (_c, _id, json) => {
		const { reviewToken, ...rest } = json;
		void reviewToken;
		const reviewed = previewInvoiceRevision({ quoteEpoch: 0 }, current, rest);
		applyInvoiceRevision(current, reviewed.body, rest, '00000000-0000-0000-0000-000000000001');
		return { ok: true, data: {} as never, setCookies: [] };
	});
});

const reprice = (v: QuoteFormValues, price = '300.00') => {
	v.lines[0].unitPrice = price;
	return v;
};
async function reviewed(
	action: 'previewQuoteRevision' | 'previewInvoiceRevision',
	v: QuoteFormValues,
	e = {}
) {
	return (await actions![action]!(event(v, e))) as {
		quoteValues: QuoteFormValues;
		preview: { mode: string };
		notices?: { reviewStale?: boolean; noChange?: boolean };
		quoteError?: string;
	};
}

describe('opening the editor', () => {
	it.each([
		['quoted', '?quote-revision', 'QUOTE_REVISION'],
		['booked', '?invoice-revision', 'INVOICE_AMENDMENT'],
		['served', '?invoice-revision', 'INVOICE_AMENDMENT'],
		['unquoted', '?quote', 'INITIAL_QUOTE']
	] as const)('%s opens %s as %s without a preview for revisions', async (state, search, mode) => {
		useState(state);
		backend(previewInquiryQuote).mockResolvedValue({
			ok: false,
			retryAfter: null,
			error: { status: 500, code: 'x', message: '', violations: [] }
		});
		const result = (await load(pageEvent(search)))!;
		expect(result).toHaveProperty('editorMode', mode);
		if (mode !== 'INITIAL_QUOTE') {
			// A revision opens on the unchanged current state, which would be a no-op; nothing previews.
			expect(previewInquiryQuote).not.toHaveBeenCalled();
			expect(previewInquiryQuoteRevision).not.toHaveBeenCalled();
			expect(previewInquiryInvoiceRevision).not.toHaveBeenCalled();
			expect(result).toHaveProperty('initialQuote', null);
		}
	});
	it('opens nothing for a flag the lifecycle does not offer, or without authority', async () => {
		expect(await load(pageEvent('?quote'))).toHaveProperty('editorMode', null);
		expect(await load(pageEvent('?invoice-revision'))).toHaveProperty('editorMode', null);
		expect(await load(pageEvent('?quote-revision', []))).toHaveProperty('editorMode', null);
		useState('booked');
		expect(await load(pageEvent('?quote-revision&invoice-revision'))).toHaveProperty(
			'editorMode',
			'INVOICE_AMENDMENT'
		);
		useState('closed');
		expect(await load(pageEvent('?invoice-revision&quote-revision&quote'))).toHaveProperty(
			'editorMode',
			null
		);
	});
	it('reads no history unless it is asked for, and tolerates its failure', async () => {
		useState('booked');
		await load(pageEvent('?invoice-revision'));
		expect(getFinancialDocumentHistory).not.toHaveBeenCalled();
		backend(getFinancialDocumentHistory).mockResolvedValue({
			ok: false,
			retryAfter: null,
			error: { status: 500, code: 'x', message: 'PRIVATE', violations: [] }
		});
		backend(getDepositRequirementHistory).mockResolvedValue({
			ok: true,
			data: { revisions: [] },
			setCookies: []
		});
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = (await load(pageEvent('?history')))!;
		expect(result).toMatchObject({
			history: { state: 'unavailable' },
			historyOpen: true,
			requestError: null
		});
		expect((result as { staffRequest: unknown }).staffRequest).not.toBeNull();
		expect(JSON.stringify(spy.mock.calls)).not.toContain('PRIVATE');
		spy.mockRestore();
	});
	it('shows a malformed history as unavailable, never an empty timeline', async () => {
		useState('booked');
		backend(getFinancialDocumentHistory).mockResolvedValue({
			ok: true,
			data: { id: current.financial.id, versions: 'many' } as never,
			setCookies: []
		});
		backend(getDepositRequirementHistory).mockResolvedValue({
			ok: true,
			data: { revisions: [] },
			setCookies: []
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await load(pageEvent('?history'))).toMatchObject({ history: { state: 'unavailable' } });
	});
	it('serves a coherent history when both reads agree', async () => {
		useState('invoice-financial-amendment');
		const h = ensureHistory(current);
		backend(getFinancialDocumentHistory).mockResolvedValue({
			ok: true,
			data: {
				id: current.financial.id,
				inquiryId: current.inquiry.id,
				versions: h.versions
			} as never,
			setCookies: []
		});
		backend(getDepositRequirementHistory).mockResolvedValue({
			ok: true,
			data: { revisions: h.deposits } as never,
			setCookies: []
		});
		expect(await load(pageEvent('?history'))).toMatchObject({ history: { state: 'ready' } });
	});
});

describe('quote revision', () => {
	it('previews the complete reviewed command with every expected identity, once', async () => {
		const values = reprice(editorValues(current, 'QUOTE_REVISION'));
		const result = await reviewed('previewQuoteRevision', values);
		expect(result.preview.mode).toBe('QUOTE_REVISION');
		const sent = body(backend(previewInquiryQuoteRevision).mock.calls[0]);
		expect(sent).toMatchObject({
			expectedDocumentVersion: 2,
			expectedDepositRequirementRevision: 1,
			servicePlanAction: 'RETAIN',
			terms: { type: 'FIXED', amount: '300.00', currency: 'USD' }
		});
		expect(sent).not.toHaveProperty('servicePlan');
		expect(sent).not.toHaveProperty('reviewToken');
		expect((sent.lines as unknown[]).length).toBe(current.financial.lines.length);
		// Never an approver identity: the backend derives it from the session.
		expect(JSON.stringify(sent)).not.toMatch(/approvedBy|issuedBy/);
	});
	it('publishes exactly what was reviewed with the preview’s own token, then redirects with the return context', async () => {
		const values = reprice(editorValues(current, 'QUOTE_REVISION'));
		const first = await reviewed('previewQuoteRevision', values);
		const from = encodeURIComponent('filter=quoted');
		const e = event(first.quoteValues, { search: `?quote-revision&from=${from}` });
		await expect(actions!.reviseQuote!(e)).rejects.toMatchObject({
			status: 303,
			location: `/requests/${inquiryId}?from=${from}`
		});
		expect(reviseInquiryQuote).toHaveBeenCalledOnce();
		const sent = body(backend(reviseInquiryQuote).mock.calls[0]);
		const previewed = body(backend(previewInquiryQuoteRevision).mock.calls[0]);
		expect(sent).toEqual({ ...previewed, reviewToken: first.quoteValues.reviewToken });
		expect(first.quoteValues.reviewToken).toMatch(/^[a-f0-9]{64}$/);
	});
	it('after publishing, the new proposal replaces the old one for payments', async () => {
		const before = current.proposal!.id;
		const first = await reviewed(
			'previewQuoteRevision',
			reprice(editorValues(current, 'QUOTE_REVISION'))
		);
		await expect(actions!.reviseQuote!(event(first.quoteValues))).rejects.toMatchObject({
			status: 303
		});
		expect(current.proposal!.id).not.toBe(before);
		expect(current.proposalHistory.map((p) => p.id)).toEqual([before, current.proposal!.id]);
		expect(current.depositRequirement).toMatchObject({ satisfied: false });
	});
	it('re-previews instead of publishing after any edit since the review', async () => {
		const first = await reviewed(
			'previewQuoteRevision',
			reprice(editorValues(current, 'QUOTE_REVISION'))
		);
		const edited = structuredClone(first.quoteValues);
		edited.lines[0].unitPrice = '310.00';
		const again = (await actions!.reviseQuote!(event(edited))) as {
			notices: { reviewStale: boolean };
			quoteValues: QuoteFormValues;
		};
		expect(again.notices.reviewStale).toBe(true);
		expect(reviseInquiryQuote).not.toHaveBeenCalled();
		expect(again.quoteValues.reviewToken).not.toBe(first.quoteValues.reviewToken);
	});
	it.each([
		['the plan action', (v: QuoteFormValues) => (v.description = 'Another plan')],
		[
			'the deposit terms',
			(v: QuoteFormValues) => {
				v.deposit!.depositChoice = 'percentage';
				v.deposit!.depositPercentage = '40';
			}
		],
		['a line note', (v: QuoteFormValues) => (v.lines[0].note = 'Changed')],
		['a selection', (v: QuoteFormValues) => (v.items[0].label = 'Changed')]
	])('binds %s into the review', async (_name, edit) => {
		const first = await reviewed(
			'previewQuoteRevision',
			reprice(editorValues(current, 'QUOTE_REVISION'))
		);
		const edited = structuredClone(first.quoteValues);
		edit(edited);
		await actions!.reviseQuote!(event(edited));
		expect(reviseInquiryQuote).not.toHaveBeenCalled();
	});
	it('shows a stale backend review as a fresh preview and never resubmits the new token', async () => {
		const first = await reviewed(
			'previewQuoteRevision',
			reprice(editorValues(current, 'QUOTE_REVISION'))
		);
		backend(reviseInquiryQuote).mockResolvedValueOnce({
			ok: false,
			retryAfter: null,
			error: { status: 409, code: 'QUOTE_REVIEW_STALE', message: '', violations: [] }
		});
		const result = (await actions!.reviseQuote!(event(first.quoteValues))) as {
			notices: { reviewStale: boolean };
			preview: unknown;
		};
		expect(result.notices.reviewStale).toBe(true);
		expect(result.preview).toBeTruthy();
		expect(reviseInquiryQuote).toHaveBeenCalledOnce();
	});
	it('reports a no-op as guidance, in place, without asking for a reload', async () => {
		const values = editorValues(current, 'QUOTE_REVISION');
		const result = (await actions!.previewQuoteRevision!(event(values))) as {
			status: number;
			data: { quoteError: string; reviewRequired: boolean; notices: { noChange: boolean } };
		};
		expect(result.status).toBe(422);
		expect(result.data.quoteError).toBe(
			'Nothing has changed. Update the pricing or service details before publishing a new version.'
		);
		expect(result.data.reviewRequired).toBe(false);
		expect(result.data.notices.noChange).toBe(true);
	});
	it('refuses to publish when the booking moved since the review, and never retries', async () => {
		const first = await reviewed(
			'previewQuoteRevision',
			reprice(editorValues(current, 'QUOTE_REVISION'))
		);
		current.proposal = { ...current.proposal!, id: '9'.repeat(8) + current.proposal!.id.slice(8) };
		current.proposalHistory[0] = structuredClone(current.proposal);
		const result = (await actions!.reviseQuote!(event(first.quoteValues))) as {
			status: number;
			data: { reviewRequired: boolean; quoteValues: QuoteFormValues };
		};
		expect(result.status).toBe(409);
		expect(result.data.reviewRequired).toBe(true);
		// The edits survive for a human to re-review; they are not approved.
		expect(result.data.quoteValues.lines[0].unitPrice).toBe('300.00');
		expect(reviseInquiryQuote).not.toHaveBeenCalled();
	});
	it('treats an uncertain publication as a review state after one attempt', async () => {
		const first = await reviewed(
			'previewQuoteRevision',
			reprice(editorValues(current, 'QUOTE_REVISION'))
		);
		backend(reviseInquiryQuote).mockResolvedValueOnce({
			ok: false,
			retryAfter: null,
			error: { status: 500, code: 'internal_failure', message: 'PRIVATE', violations: [] }
		});
		const result = (await actions!.reviseQuote!(event(first.quoteValues))) as {
			status: number;
			data: { quoteError: string; reviewRequired: boolean };
		};
		expect(result.status).toBe(503);
		expect(result.data.reviewRequired).toBe(true);
		expect(result.data.quoteError).toMatch(/couldn’t confirm/);
		expect(result.data.quoteError).not.toContain('PRIVATE');
		expect(reviseInquiryQuote).toHaveBeenCalledOnce();
	});
	it('refuses a deposit-managing action without deposit authority and any invoice form', async () => {
		const values = reprice(editorValues(current, 'QUOTE_REVISION'));
		expect(
			await actions!.previewQuoteRevision!(event(values, { permissions: invoicePermissions }))
		).toMatchObject({
			status: 403
		});
		const invoice = await actions!.previewInvoiceRevision!(event(values));
		expect(invoice).toMatchObject({ status: 422 });
		expect(previewInquiryQuoteRevision).not.toHaveBeenCalled();
		expect(previewInquiryInvoiceRevision).not.toHaveBeenCalled();
	});
	it('refuses a revision once the request is booked, or declined', async () => {
		const values = reprice(editorValues(current, 'QUOTE_REVISION'));
		useState('booked');
		expect(await actions!.previewQuoteRevision!(event(values))).toMatchObject({ status: 409 });
		expect(previewInquiryQuoteRevision).not.toHaveBeenCalled();
		useState('declined');
		expect(await actions!.previewQuoteRevision!(event(values))).toMatchObject({ status: 409 });
	});
	it('a service-only change sends REPLACE with the complete plan and no financial edit', async () => {
		const values = editorValues(current, 'QUOTE_REVISION');
		values.items[1].label = 'Chocolate';
		const result = await reviewed('previewQuoteRevision', values);
		const sent = body(backend(previewInquiryQuoteRevision).mock.calls[0]);
		expect(sent.servicePlanAction).toBe('REPLACE');
		expect(sent.servicePlan).toMatchObject({
			description: current.effectiveServicePlan!.description,
			items: [{ label: 'Churros' }, { label: 'Chocolate' }]
		});
		expect(result.preview).toMatchObject({
			revision: { servicePlanChange: true, quote: { financialChange: false, quoteVersion: 2 } }
		});
	});
	it('clears only on the explicit choice', async () => {
		const values = editorValues(current, 'QUOTE_REVISION');
		values.description = '';
		const blank = (await actions!.previewQuoteRevision!(event(values))) as { status: number };
		expect(blank.status).toBe(422);
		expect(previewInquiryQuoteRevision).not.toHaveBeenCalled();
		values.clearPlan = true;
		await actions!.previewQuoteRevision!(event(values));
		expect(body(backend(previewInquiryQuoteRevision).mock.calls[0])).toMatchObject({
			servicePlanAction: 'CLEAR'
		});
		expect(body(backend(previewInquiryQuoteRevision).mock.calls[0])).not.toHaveProperty(
			'servicePlan'
		);
	});
	it('reports a removed noted line as a replaced plan, never a silently kept note', async () => {
		const values = editorValues(current, 'QUOTE_REVISION');
		values.lines.push({
			key: 'extra',
			description: 'Extra',
			unitPrice: '10.00',
			taxAmount: '0.00',
			currency: 'USD',
			note: ''
		});
		values.lines.shift();
		await actions!.previewQuoteRevision!(event(values));
		const sent = body(backend(previewInquiryQuoteRevision).mock.calls[0]);
		expect(sent.servicePlanAction).toBe('REPLACE');
		expect(JSON.stringify(sent.servicePlan)).not.toContain('Negotiated');
	});
});

describe('invoice amendment', () => {
	beforeEach(() => useState('booked'));
	const amend = () => {
		const values = editorValues(current, 'INVOICE_AMENDMENT');
		values.lines.push({
			key: 'extra-hour',
			description: 'Extra hour',
			unitPrice: '250.00',
			taxAmount: '0.00',
			currency: 'USD',
			note: ''
		});
		return values;
	};
	const options = { permissions: invoicePermissions, search: '?invoice-revision' };
	it('needs only invoice authority and posts no deposit or terms', async () => {
		const result = await reviewed('previewInvoiceRevision', amend(), options);
		expect(result.preview.mode).toBe('INVOICE_AMENDMENT');
		const sent = body(backend(previewInquiryInvoiceRevision).mock.calls[0]);
		expect(sent).toMatchObject({ expectedDocumentVersion: 3, servicePlanAction: 'RETAIN' });
		expect(sent).not.toHaveProperty('terms');
		expect(sent).not.toHaveProperty('expectedDepositRequirementRevision');
	});
	it('refuses without invoice authority, and refuses a deposit smuggled into the form', async () => {
		const values = amend();
		const none = await actions!.previewInvoiceRevision!(
			event(values, { ...options, permissions: ['commerce.financial-document.create'] })
		);
		expect(none).toMatchObject({ status: 403 });
		const smuggled = await actions!.previewInvoiceRevision!(
			event(values, { ...options, extra: { depositChoice: 'fixed', depositAmount: '1.00' } })
		);
		expect(smuggled).toMatchObject({ status: 422 });
		expect(previewInquiryInvoiceRevision).not.toHaveBeenCalled();
	});
	it('approves the reviewed amendment once, then redirects; payments and fulfillment are untouched', async () => {
		const paid = structuredClone(current.payments);
		const first = await reviewed('previewInvoiceRevision', amend(), options);
		await expect(actions!.amendInvoice!(event(first.quoteValues, options))).rejects.toMatchObject({
			status: 303,
			location: `/requests/${inquiryId}`
		});
		expect(reviseInquiryInvoice).toHaveBeenCalledOnce();
		expect(body(backend(reviseInquiryInvoice).mock.calls[0])).toMatchObject({
			reviewToken: first.quoteValues.reviewToken
		});
		expect(current.payments).toEqual(paid);
		expect(current.inquiry.lifecycle.stage).toBe('BOOKED');
		expect(current.depositRequirement).toMatchObject({ state: 'ACTIVE', satisfied: true });
		expect(current.proposalHistory).toHaveLength(1);
	});
	it('re-reviews when a payment lands between preview and approval', async () => {
		const first = await reviewed('previewInvoiceRevision', amend(), options);
		backend(reviseInquiryInvoice).mockResolvedValueOnce({
			ok: false,
			retryAfter: null,
			error: { status: 409, code: 'QUOTE_REVIEW_STALE', message: '', violations: [] }
		});
		const result = (await actions!.amendInvoice!(event(first.quoteValues, options))) as {
			notices: { reviewStale: boolean };
		};
		expect(result.notices.reviewStale).toBe(true);
	});
	it('keeps amending after the event is served, and refuses once closed', async () => {
		useState('served');
		const values = amend();
		expect((await reviewed('previewInvoiceRevision', values, options)).preview.mode).toBe(
			'INVOICE_AMENDMENT'
		);
		useState('closed');
		expect(await actions!.previewInvoiceRevision!(event(values, options))).toMatchObject({
			status: 409
		});
	});
	it('reports an unchanged draft as a no-op and a conflict as a reload', async () => {
		const unchanged = await actions!.previewInvoiceRevision!(
			event(editorValues(current, 'INVOICE_AMENDMENT'), options)
		);
		expect(unchanged).toMatchObject({ status: 422, data: { notices: { noChange: true } } });
		const values = amend();
		current.financial.version++;
		expect(await actions!.previewInvoiceRevision!(event(values, options))).toMatchObject({
			status: 409,
			data: { reviewRequired: true }
		});
	});
});
