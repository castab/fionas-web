import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actions, load } from './+page.server.js';
import {
	getInquiryForm,
	getOfferingCatalog,
	getStaffRequest,
	issueInquiryProposal,
	previewInquiryQuote
} from '$lib/server/staff-request.js';
import { applySetCookies } from '$lib/server/auth.js';
import type { PreviewInquiryQuoteRequest } from '$lib/quote-contract.js';
import type { QuoteActionResult } from '$lib/quote-builder.js';
import { mayaId, requestFixtures } from '../../../../../e2e/request-fixture.mjs';
import { inquiryForm, offeringCatalog } from '../../../../../e2e/catalog-fixture.mjs';

vi.mock('$lib/server/staff-request.js', () => ({
	markInquiryServed: vi.fn(),
	closeInquiry: vi.fn(),
	getStaffRequest: vi.fn(),
	getOfferingCatalog: vi.fn(),
	getInquiryForm: vi.fn(),
	issueInquiryProposal: vi.fn(),
	previewInquiryQuote: vi.fn()
}));
vi.mock('$lib/server/auth.js', () => ({ applySetCookies: vi.fn() }));
vi.mock('$lib/server/config.js', () => ({
	backendConfig: () => ({ baseUrl: 'http://api.test', origin: 'http://admin.test' })
}));

const PROPOSAL_PERMISSIONS = [
	'commerce.financial-document.create',
	'commerce.deposit-requirement.manage'
];
const lineIds = [
	'20000000-0000-0000-0000-000000000001',
	'20000000-0000-0000-0000-000000000002',
	'20000000-0000-0000-0000-000000000003'
];
const baseEntries: [string, string][] = [
	['expectedVersion', '1'],
	['depositChoice', 'suggested'],
	['reviewedSuggestionType', 'PERCENTAGE'],
	['reviewedSuggestionValue', '20']
];
const mayaService: [string, string][] = [
	['service', '1'],
	['catalogRevision', '15'],
	['category', 'soft-serve-flavor'],
	['category', 'hand-scooped-flavor'],
	['category', 'topping'],
	['category', 'cone-option'],
	['guestCount', '40'],
	['durationMinutes', '90'],
	['pick:soft-serve-flavor', 'vanilla'],
	['pick:soft-serve-flavor', 'chocolate'],
	['pick:hand-scooped-flavor', 'hand-scooped-chocolate-chip'],
	['pick:hand-scooped-flavor', 'hand-scooped-strawberry'],
	['pick:hand-scooped-flavor', 'hand-scooped-mint-chip'],
	['pick:hand-scooped-flavor', 'hand-scooped-vanilla-bean'],
	['pick:topping', 'sprinkles'],
	['pick:topping', 'oreos'],
	['pick:topping', 'strawberries'],
	['pick:topping', 'brownies'],
	['pick:cone-option', 'waffle-cone']
];

function event(
	entries: [string, string][] = baseEntries,
	{
		permissions = PROPOSAL_PERMISSIONS,
		action = 'previewQuote',
		search = ''
	}: { permissions?: string[]; action?: string; search?: string } = {}
) {
	const url = new URL(`http://admin.test/requests/${mayaId}?quote${search}&/${action}`);
	return {
		params: { inquiryId: mayaId },
		url,
		request: new Request(url, {
			method: 'POST',
			headers: { cookie: 'session=staff' },
			body: new URLSearchParams(entries)
		}),
		locals: {
			user: { id: 'staff', username: 'staff', displayName: 'Staff', roles: [], permissions }
		},
		cookies: {},
		setHeaders: vi.fn()
	} as unknown as Parameters<typeof load>[0] & Parameters<typeof actions.previewQuote>[0];
}

function loadEvent(search = '', permissions = PROPOSAL_PERMISSIONS) {
	const url = new URL(`http://admin.test/requests/${mayaId}${search}`);
	return {
		params: { inquiryId: mayaId },
		url,
		request: new Request(url, { headers: { cookie: 'session=staff' } }),
		locals: {
			user: { id: 'staff', username: 'staff', displayName: 'Staff', roles: [], permissions }
		},
		cookies: {},
		setHeaders: vi.fn()
	} as unknown as Parameters<typeof load>[0];
}

function backendFailure(status: number, code = 'failure', violations: string[] = []) {
	return {
		ok: false as const,
		error: { status, code, message: 'PRIVATE diagnostic', violations },
		retryAfter: null
	};
}

/** A coherent preview for Maya's Estimate in the requested mode; amounts are fixture values. */
function previewFor(body: PreviewInquiryQuoteRequest, token = 'a') {
	const maya = requestFixtures()[mayaId];
	const repricing = body.composition.pricing.mode === 'REPRICE_CONFIGURATION';
	return {
		inquiryId: mayaId,
		documentId: maya.financial.id,
		reviewedDocumentVersion: body.expectedDocumentVersion,
		estimateTotal: '415.00',
		pricingBasis: body.composition.pricing.mode,
		catalogRevision: 15,
		financialChange: false,
		quoteVersion: 2,
		service: {
			guestCount: 40,
			guestCountIsMinimum: false,
			durationMinutes: 90,
			selections: [
				{
					category: 'cone-option',
					displayName: 'Cones & cups',
					offerings: [{ offering: 'waffle-cone', displayName: 'Waffle cones' }]
				}
			]
		},
		lines: maya.financial.lines.map(({ id, ...line }, index) =>
			repricing
				? {
						...line,
						origin: {
							type: 'GENERATED' as const,
							source: [
								{ type: 'BASE_SERVICE' as const },
								{ type: 'ICE_CREAM_SERVICE' as const },
								{
									type: 'SELECTED_OFFERING' as const,
									category: 'cone-option',
									offering: 'waffle-cone'
								}
							][index]
						}
					}
				: { ...line, lineItemId: id, origin: { type: 'ESTIMATE_LINE' as const } }
		),
		subtotal: '415.00',
		taxAmount: '0.00',
		total: '415.00',
		currency: 'USD',
		deposit: { terms: body.terms, requiredAmount: { amount: '83.00', currency: 'USD' } },
		reviewToken: token.repeat(64)
	};
}

function previewBody(call = 0): PreviewInquiryQuoteRequest {
	return vi.mocked(previewInquiryQuote).mock.calls[call][2];
}

/** Preview, then post the same form back with the preview's review fields, as the browser does. */
async function reviewed(entries: [string, string][] = baseEntries) {
	const result = (await actions.previewQuote(event(entries))) as QuoteActionResult;
	const values = result.quoteValues!;
	vi.clearAllMocks();
	mockDefaults();
	return [
		...entries,
		['reviewToken', values.reviewToken],
		['reviewedBasis', values.reviewedBasis],
		['reviewedFingerprint', values.reviewedFingerprint]
	] as [string, string][];
}

function mockDefaults() {
	vi.mocked(getStaffRequest).mockResolvedValue({
		ok: true,
		data: requestFixtures()[mayaId],
		setCookies: ['session=read-renewed']
	});
	vi.mocked(previewInquiryQuote).mockImplementation(async (_config, _id, body) => ({
		ok: true,
		data: previewFor(body),
		setCookies: []
	}));
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
	vi.mocked(getOfferingCatalog).mockResolvedValue({
		ok: true,
		data: offeringCatalog(),
		setCookies: []
	});
	vi.mocked(getInquiryForm).mockResolvedValue({ ok: true, data: inquiryForm(), setCookies: [] });
}

beforeEach(() => {
	vi.clearAllMocks();
	mockDefaults();
});

describe('request route load', () => {
	it('reads one coherent projection with no-store and USER forwarding', async () => {
		const requestEvent = loadEvent();
		const result = await load(requestEvent);
		expect(requestEvent.setHeaders).toHaveBeenCalledWith({ 'cache-control': 'no-store' });
		expect(getStaffRequest).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			mayaId,
			'session=staff'
		);
		expect(getOfferingCatalog).not.toHaveBeenCalled();
		expect(getInquiryForm).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			staffRequest: { inquiry: { id: mayaId } },
			requestError: null,
			quoteOpen: false,
			builderChoices: null
		});
	});
	it.each([
		[403, 'forbidden'],
		[404, 'not-found'],
		[500, 'unavailable']
	] as const)('safely maps a %i read failure', async (status, requestError) => {
		vi.mocked(getStaffRequest).mockResolvedValue(backendFailure(status));
		expect(await load(loadEvent())).toMatchObject({ staffRequest: null, requestError });
	});
	it('refuses a projection without current reconciliation', async () => {
		const data = requestFixtures()[mayaId];
		vi.mocked(getStaffRequest).mockResolvedValue({
			ok: true,
			data: { ...data, financial: { ...data.financial, reconciliation: undefined } },
			setCookies: []
		});
		expect(await load(loadEvent())).toMatchObject({
			staffRequest: null,
			requestError: 'unavailable'
		});
	});
	it('reads catalog choices only while the builder is open for an eligible quoter', async () => {
		const result = await load(loadEvent('?quote'));
		expect(getOfferingCatalog).toHaveBeenCalledOnce();
		expect(getInquiryForm).toHaveBeenCalledOnce();
		expect(result).toMatchObject({
			quoteOpen: true,
			builderChoices: {
				catalogRevision: 15,
				guestMinimum: 1,
				durations: [{ value: 90 }, { value: 120 }, { value: 150 }, { value: 180 }]
			}
		});
		const choices = (result as { builderChoices: { categories: { options: { key: string }[] }[] } })
			.builderChoices;
		// Disabled offerings are never choices.
		expect(choices.categories[1].options.map((o) => o.key)).not.toContain(
			'hand-scooped-rocky-road'
		);
		vi.clearAllMocks();
		mockDefaults();
		await load(loadEvent('?quote', ['commerce.financial-document.create']));
		expect(getOfferingCatalog).not.toHaveBeenCalled();
	});
	it('leaves picks read-only when the menu cannot be read', async () => {
		vi.mocked(getInquiryForm).mockResolvedValue(backendFailure(403));
		expect(await load(loadEvent('?quote'))).toMatchObject({
			staffRequest: { inquiry: { id: mayaId } },
			builderChoices: null
		});
	});
});

describe('Preview quote action', () => {
	it.each([
		[[]],
		[['commerce.financial-document.create']],
		[['commerce.deposit-requirement.manage']]
	])('denies incomplete permissions %j before backend access', async (permissions) => {
		expect(await actions.previewQuote(event(baseEntries, { permissions }))).toMatchObject({
			status: 403
		});
		expect(getStaffRequest).not.toHaveBeenCalled();
		expect(previewInquiryQuote).not.toHaveBeenCalled();
	});
	it('previews the unchanged Estimate and returns its review fields', async () => {
		const result = (await actions.previewQuote(event())) as QuoteActionResult;
		expect(previewInquiryQuote).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			mayaId,
			{
				expectedDocumentVersion: 1,
				composition: { pricing: { mode: 'KEEP_ESTIMATE' } },
				terms: { type: 'PERCENTAGE', percentage: '20' }
			},
			'session=staff'
		);
		expect(result.preview?.total).toBe('415.00');
		expect(result.quoteValues).toMatchObject({
			reviewToken: 'a'.repeat(64),
			reviewedBasis: 'KEEP_ESTIMATE'
		});
		expect(result.quoteValues?.reviewedFingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(applySetCookies).toHaveBeenCalledWith(expect.anything(), ['session=read-renewed']);
	});
	it('composes overrides by line id and adjustments in order, ignoring a blank native row', async () => {
		await actions.previewQuote(
			event([
				...baseEntries,
				...mayaService,
				[`override:amount:EXISTING_LINE:${lineIds[1]}`, '145'],
				[`override:original:EXISTING_LINE:${lineIds[1]}`, '180.00'],
				[`override:reason:EXISTING_LINE:${lineIds[1]}`, ' Negotiated package rate '],
				[`override:amount:EXISTING_LINE:${lineIds[0]}`, '205.0'],
				[`override:original:EXISTING_LINE:${lineIds[0]}`, '205.00'],
				[`override:reason:EXISTING_LINE:${lineIds[0]}`, ''],
				['adjustment', 'travel-1'],
				['adjustment:kind:travel-1', 'CHARGE'],
				['adjustment:description:travel-1', 'Additional travel fee'],
				['adjustment:detail:travel-1', ''],
				['adjustment:amount:travel-1', '25.00'],
				['adjustment:reason:travel-1', 'Outside normal service area'],
				['adjustment', 'courtesy-1'],
				['adjustment:kind:courtesy-1', 'DISCOUNT'],
				['adjustment:description:courtesy-1', 'Courtesy discount'],
				['adjustment:detail:courtesy-1', 'Thank you'],
				['adjustment:amount:courtesy-1', '20'],
				['adjustment:reason:courtesy-1', 'Customer accommodation'],
				['adjustment', 'line-3'],
				['adjustment:kind:line-3', 'CHARGE'],
				['adjustment:description:line-3', ''],
				['adjustment:detail:line-3', ''],
				['adjustment:amount:line-3', ''],
				['adjustment:reason:line-3', '']
			])
		);
		expect(previewBody().composition).toEqual({
			pricing: { mode: 'KEEP_ESTIMATE' },
			overrides: [
				{
					target: { type: 'EXISTING_LINE', lineItemId: lineIds[1] },
					finalAmount: '145',
					currency: 'USD',
					reason: 'Negotiated package rate'
				}
			],
			adjustments: [
				{
					clientKey: 'travel-1',
					kind: 'CHARGE',
					description: 'Additional travel fee',
					amount: '25.00',
					currency: 'USD',
					reason: 'Outside normal service area'
				},
				{
					clientKey: 'courtesy-1',
					kind: 'DISCOUNT',
					description: 'Courtesy discount',
					subDescription: 'Thank you',
					amount: '20',
					currency: 'USD',
					reason: 'Customer accommodation'
				}
			]
		});
	});
	it('previews changed picks as a service revision first, then reprices when they change price', async () => {
		const entries = mayaService.map(([key, value]): [string, string] =>
			key === 'pick:soft-serve-flavor' && value === 'chocolate' ? [key, 'horchata'] : [key, value]
		);
		vi.mocked(previewInquiryQuote).mockResolvedValueOnce(
			backendFailure(422, 'validation_failed', ['SERVICE_SELECTIONS_CHANGE_PRICING'])
		);
		const result = (await actions.previewQuote(
			event([
				...baseEntries,
				...entries,
				[`override:amount:EXISTING_LINE:${lineIds[1]}`, '145'],
				[`override:original:EXISTING_LINE:${lineIds[1]}`, '180.00'],
				[`override:reason:EXISTING_LINE:${lineIds[1]}`, 'Package']
			])
		)) as QuoteActionResult;
		expect(previewInquiryQuote).toHaveBeenCalledTimes(2);
		expect(previewBody(0).composition.pricing).toEqual({
			mode: 'REVISE_SERVICE_SELECTIONS',
			catalogRevision: 15,
			selections: [
				{ category: 'soft-serve-flavor', offerings: ['vanilla', 'horchata'] },
				{
					category: 'hand-scooped-flavor',
					offerings: [
						'hand-scooped-chocolate-chip',
						'hand-scooped-strawberry',
						'hand-scooped-mint-chip',
						'hand-scooped-vanilla-bean'
					]
				},
				{ category: 'topping', offerings: ['sprinkles', 'oreos', 'strawberries', 'brownies'] },
				{ category: 'cone-option', offerings: ['waffle-cone'] }
			]
		});
		expect(previewBody(0).composition.overrides).toHaveLength(1);
		expect(previewBody(1).composition.pricing).toMatchObject({
			mode: 'REPRICE_CONFIGURATION',
			guestCount: 40,
			guestCountIsMinimum: false,
			durationMinutes: 90
		});
		// Line-id overrides cannot target recalculated lines; they are dropped and staff are told.
		expect(previewBody(1).composition.overrides).toBeUndefined();
		expect(result.notices).toEqual({ repriced: true, overridesCleared: true });
		expect(result.quoteValues?.reviewedBasis).toBe('REPRICE_CONFIGURATION');
	});
	it('reprices directly when guests, minimum or duration change', async () => {
		const entries = mayaService.map(([key, value]): [string, string] =>
			key === 'guestCount' ? [key, '50'] : [key, value]
		);
		await actions.previewQuote(event([...baseEntries, ...entries, ['guestCountIsMinimum', 'on']]));
		expect(previewInquiryQuote).toHaveBeenCalledOnce();
		expect(previewBody().composition.pricing).toMatchObject({
			mode: 'REPRICE_CONFIGURATION',
			guestCount: 50,
			guestCountIsMinimum: true
		});
	});
	it('keeps the Estimate when the posted service matches it in any order', async () => {
		const reordered = [...mayaService].reverse();
		await actions.previewQuote(event([...baseEntries, ...reordered]));
		expect(previewBody().composition.pricing).toEqual({ mode: 'KEEP_ESTIMATE' });
	});
	it.each([
		[
			'override without a reason',
			[
				[`override:amount:EXISTING_LINE:${lineIds[1]}`, '145'],
				[`override:original:EXISTING_LINE:${lineIds[1]}`, '180.00'],
				[`override:reason:EXISTING_LINE:${lineIds[1]}`, ' ']
			],
			`override:reason:EXISTING_LINE:${lineIds[1]}`
		],
		[
			'sub-cent override',
			[
				[`override:amount:EXISTING_LINE:${lineIds[1]}`, '145.001'],
				[`override:original:EXISTING_LINE:${lineIds[1]}`, '180.00'],
				[`override:reason:EXISTING_LINE:${lineIds[1]}`, 'Package']
			],
			`override:amount:EXISTING_LINE:${lineIds[1]}`
		],
		[
			'zero adjustment',
			[
				['adjustment', 'a1'],
				['adjustment:kind:a1', 'CREDIT'],
				['adjustment:description:a1', 'Credit'],
				['adjustment:amount:a1', '0'],
				['adjustment:reason:a1', 'Goodwill']
			],
			'adjustment:amount:a1'
		],
		[
			'invalid percentage',
			[
				['depositChoice', 'percentage'],
				['depositPercentage', '101']
			],
			'depositPercentage'
		]
	] as [string, [string, string][], string][])(
		'returns correctable field errors for a %s without previewing',
		async (_name, extra, field) => {
			const entries = [...baseEntries.filter(([key]) => !extra.some(([k]) => k === key)), ...extra];
			const result = await actions.previewQuote(event(entries));
			expect(result).toMatchObject({
				status: 422,
				data: { reviewRequired: false, fieldErrors: { [field]: expect.any(String) } }
			});
			expect(previewInquiryQuote).not.toHaveBeenCalled();
		}
	);
	it.each([
		['duplicate single field', [...baseEntries, ['guestCount', '1'], ['guestCount', '2']]],
		['unknown field', [...baseEntries, ['documentId', 'another-document']]],
		['browser currency', [...baseEntries, ['currency', 'USD']]],
		['service values without the service marker', [...baseEntries, ['guestCount', '40']]],
		['picks for an undeclared category', [...baseEntries, ...mayaService, ['pick:other', 'x']]],
		[
			'invalid adjustment kind',
			[...baseEntries, ['adjustment', 'a1'], ['adjustment:kind:a1', 'FREE']]
		],
		[
			'invalid override target',
			[
				...baseEntries,
				['override:amount:EXISTING_LINE:nope', '1'],
				['override:original:EXISTING_LINE:nope', '2']
			]
		],
		['invalid expected version', [['expectedVersion', '0'], ...baseEntries.slice(1)]]
	] as [string, [string, string][]][])(
		'rejects a %s before any backend access',
		async (_name, entries) => {
			expect(await actions.previewQuote(event(entries))).toMatchObject({
				status: 422,
				data: { reviewRequired: true }
			});
			expect(getStaffRequest).not.toHaveBeenCalled();
			expect(previewInquiryQuote).not.toHaveBeenCalled();
		}
	);
	it('requires review of a changed suggestion instead of substituting it', async () => {
		const data = requestFixtures()[mayaId];
		data.suggestedDepositTerms = { type: 'PERCENTAGE', percentage: '25' };
		vi.mocked(getStaffRequest).mockResolvedValue({ ok: true, data, setCookies: [] });
		expect(await actions.previewQuote(event())).toMatchObject({
			status: 409,
			data: { reviewRequired: true }
		});
		expect(previewInquiryQuote).not.toHaveBeenCalled();
	});
	it('maps violations to builder sections without exposing diagnostics', async () => {
		vi.mocked(previewInquiryQuote).mockResolvedValue(
			backendFailure(422, 'validation_failed', ['QUOTE_TOTAL_NOT_POSITIVE', 'OFFERING_UNAVAILABLE'])
		);
		const result = await actions.previewQuote(event());
		expect(result).toMatchObject({
			status: 422,
			data: {
				reviewRequired: false,
				feedback: {
					total: [expect.stringContaining('more than $0')],
					service: [expect.stringContaining('unavailable')]
				}
			}
		});
		expect(JSON.stringify(result)).not.toContain('PRIVATE');
	});
	it('asks staff to review a refreshed menu after a stale catalog revision', async () => {
		vi.mocked(previewInquiryQuote).mockResolvedValue(backendFailure(409, 'CATALOG_REVISION_STALE'));
		expect(
			await actions.previewQuote(
				event([
					...baseEntries,
					...mayaService.map(([k, v]): [string, string] =>
						k === 'guestCount' ? [k, '41'] : [k, v]
					)
				])
			)
		).toMatchObject({
			status: 409,
			data: { reviewRequired: false, catalogStale: true }
		});
	});
	it('lets staff retry a preview that failed in the service, since nothing was written', async () => {
		vi.mocked(previewInquiryQuote).mockResolvedValue(backendFailure(500));
		expect(await actions.previewQuote(event())).toMatchObject({
			status: 503,
			data: { reviewRequired: false, quoteError: expect.stringContaining('Nothing was issued') }
		});
	});
	it('refuses a preview that does not belong to this request', async () => {
		vi.mocked(previewInquiryQuote).mockImplementation(async (_config, _id, body) => ({
			ok: true,
			data: { ...previewFor(body), inquiryId: 'another-inquiry' },
			setCookies: []
		}));
		expect(await actions.previewQuote(event())).toMatchObject({
			status: 503,
			data: { reviewRequired: true }
		});
	});
	it('does not proxy a mismatched projection or an ineligible request', async () => {
		const mismatched = requestFixtures()[mayaId];
		mismatched.financial.inquiryId = 'another-inquiry';
		vi.mocked(getStaffRequest).mockResolvedValue({ ok: true, data: mismatched, setCookies: [] });
		expect(await actions.previewQuote(event())).toMatchObject({ status: 503 });
		const quoted = requestFixtures()['00000000-0000-0000-0000-000000000001'];
		vi.mocked(getStaffRequest).mockResolvedValue({
			ok: true,
			data: {
				...quoted,
				inquiry: { ...quoted.inquiry, id: mayaId },
				financial: { ...quoted.financial, inquiryId: mayaId }
			},
			setCookies: []
		});
		expect(await actions.previewQuote(event())).not.toMatchObject({ preview: expect.anything() });
		expect(previewInquiryQuote).not.toHaveBeenCalled();
	});
	it('redirects an expired backend session to login', async () => {
		vi.mocked(getStaffRequest).mockResolvedValue(backendFailure(401));
		await expect(actions.previewQuote(event())).rejects.toMatchObject({
			status: 303,
			location: '/login'
		});
	});
});

describe('Issue quote action', () => {
	it('issues exactly the reviewed composition once and redirects to a clean GET', async () => {
		const entries = await reviewed([
			...baseEntries,
			['adjustment', 'travel-1'],
			['adjustment:kind:travel-1', 'CHARGE'],
			['adjustment:description:travel-1', 'Additional travel fee'],
			['adjustment:amount:travel-1', '25.00'],
			['adjustment:reason:travel-1', 'Outside normal service area']
		]);
		await expect(
			actions.issueQuote(event(entries, { action: 'issueQuote' }))
		).rejects.toMatchObject({
			status: 303,
			location: `/requests/${mayaId}`
		});
		expect(previewInquiryQuote).not.toHaveBeenCalled();
		expect(issueInquiryProposal).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			mayaId,
			1,
			{ type: 'PERCENTAGE', percentage: '20' },
			'session=staff',
			{
				composition: {
					pricing: { mode: 'KEEP_ESTIMATE' },
					adjustments: [
						{
							clientKey: 'travel-1',
							kind: 'CHARGE',
							description: 'Additional travel fee',
							amount: '25.00',
							currency: 'USD',
							reason: 'Outside normal service area'
						}
					]
				},
				reviewToken: 'a'.repeat(64)
			}
		);
		expect(applySetCookies).toHaveBeenCalledWith(expect.anything(), ['session=renewed']);
	});
	it('issues a repriced review with the reviewed basis even though the edits read as a revision', async () => {
		vi.mocked(previewInquiryQuote).mockResolvedValueOnce(
			backendFailure(422, 'validation_failed', ['SERVICE_SELECTIONS_CHANGE_PRICING'])
		);
		const service = mayaService.map(([key, value]): [string, string] =>
			key === 'pick:cone-option' ? [key, 'cup'] : [key, value]
		);
		const entries = await reviewed([...baseEntries, ...service]);
		await expect(
			actions.issueQuote(event(entries, { action: 'issueQuote' }))
		).rejects.toMatchObject({
			status: 303
		});
		expect(vi.mocked(issueInquiryProposal).mock.calls[0][5]?.composition.pricing.mode).toBe(
			'REPRICE_CONFIGURATION'
		);
	});
	it.each([
		['without a preview', async () => [...baseEntries]],
		[
			'after an edit made since the preview',
			async () =>
				(await reviewed())
					.map(([key, value]): [string, string] =>
						key === 'depositChoice' ? [key, 'percentage'] : [key, value]
					)
					.concat([['depositPercentage', '25']])
		],
		[
			'when the service changed since a kept-Estimate preview',
			async () => {
				const entries = await reviewed([...baseEntries, ...mayaService]);
				return entries.map(([key, value]): [string, string] =>
					key === 'guestCount' ? [key, '45'] : [key, value]
				);
			}
		]
	] as [string, () => Promise<[string, string][]>][])(
		'previews again instead of issuing %s',
		async (_name, build) => {
			const entries = await build();
			const result = (await actions.issueQuote(
				event(entries, { action: 'issueQuote' })
			)) as QuoteActionResult;
			expect(issueInquiryProposal).not.toHaveBeenCalled();
			expect(previewInquiryQuote).toHaveBeenCalledOnce();
			expect(result.notices?.reviewStale).toBe(true);
			expect(result.preview).toBeDefined();
		}
	);
	it('shows a new preview after QUOTE_REVIEW_STALE and never issues it automatically', async () => {
		const entries = await reviewed();
		vi.mocked(issueInquiryProposal).mockResolvedValue(backendFailure(409, 'QUOTE_REVIEW_STALE'));
		vi.mocked(previewInquiryQuote).mockImplementation(async (_config, _id, body) => ({
			ok: true,
			data: previewFor(body, 'b'),
			setCookies: []
		}));
		const result = (await actions.issueQuote(
			event(entries, { action: 'issueQuote' })
		)) as QuoteActionResult;
		expect(issueInquiryProposal).toHaveBeenCalledOnce();
		expect(result).toMatchObject({
			notices: { reviewStale: true },
			quoteValues: { reviewToken: 'b'.repeat(64) }
		});
	});
	it('keeps a definite 422 refusal correctable', async () => {
		const entries = await reviewed();
		vi.mocked(issueInquiryProposal).mockResolvedValue(
			backendFailure(422, 'validation_failed', ['QUOTE_TOTAL_NOT_POSITIVE'])
		);
		expect(await actions.issueQuote(event(entries, { action: 'issueQuote' }))).toMatchObject({
			status: 422,
			data: { reviewRequired: false, feedback: { total: [expect.any(String)] } }
		});
		expect(issueInquiryProposal).toHaveBeenCalledOnce();
	});
	it.each([403, 404, 409, 500, 503])(
		'requires review after mutation %i and never exposes diagnostics or retries',
		async (status) => {
			const entries = await reviewed();
			vi.mocked(issueInquiryProposal).mockResolvedValue(backendFailure(status));
			const result = await actions.issueQuote(event(entries, { action: 'issueQuote' }));
			expect(result).toMatchObject({
				status: status >= 500 ? 503 : status,
				data: { reviewRequired: true }
			});
			if (status >= 500)
				expect(JSON.stringify(result)).toContain('couldn’t confirm whether the quote was issued');
			expect(JSON.stringify(result)).not.toContain('PRIVATE');
			expect(issueInquiryProposal).toHaveBeenCalledOnce();
			expect(previewInquiryQuote).not.toHaveBeenCalled();
		}
	);
	it('sends the reviewed version unchanged even when the action read sees a newer Estimate', async () => {
		const entries = await reviewed();
		const data = requestFixtures()[mayaId];
		data.financial.version = 2;
		vi.mocked(getStaffRequest).mockResolvedValue({ ok: true, data, setCookies: [] });
		vi.mocked(issueInquiryProposal).mockResolvedValue(backendFailure(409));
		expect(await actions.issueQuote(event(entries, { action: 'issueQuote' }))).toMatchObject({
			status: 409,
			data: { reviewRequired: true }
		});
		expect(vi.mocked(issueInquiryProposal).mock.calls[0][2]).toBe(1);
	});
	it('redirects 401s from the mutation without retry', async () => {
		const entries = await reviewed();
		vi.mocked(issueInquiryProposal).mockResolvedValue(backendFailure(401));
		await expect(
			actions.issueQuote(event(entries, { action: 'issueQuote' }))
		).rejects.toMatchObject({
			status: 303,
			location: '/login'
		});
		expect(issueInquiryProposal).toHaveBeenCalledOnce();
	});
	it('checks permissions again before reading or mutating', async () => {
		expect(
			await actions.issueQuote(event(baseEntries, { action: 'issueQuote', permissions: [] }))
		).toMatchObject({ status: 403 });
		expect(getStaffRequest).not.toHaveBeenCalled();
		expect(issueInquiryProposal).not.toHaveBeenCalled();
	});
});
