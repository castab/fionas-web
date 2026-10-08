import { describe, expect, it } from 'vitest';
import {
	basisStillReviewed,
	buildComposition,
	builderChoices,
	chooseBasis,
	effectiveConfiguration,
	isActiveOverride,
	isQuotePreview,
	overrideOriginalLabel,
	parseTargetKey,
	picksDiff,
	quoteInputErrors,
	quoteViolationFeedback,
	readQuoteForm,
	targetKey,
	type QuoteFormValues
} from './quote-builder.js';
import type { QuoteOverrideTarget, QuotePreviewLine } from './quote-contract.js';
import { mayaId, requestFixtures } from '../../e2e/request-fixture.mjs';
import { inquiryForm, offeringCatalog } from '../../e2e/catalog-fixture.mjs';

const deposit = {
	expectedVersion: '1',
	depositChoice: 'suggested' as const,
	reviewedSuggestionType: 'PERCENTAGE' as const,
	reviewedSuggestionValue: '20',
	depositPercentage: '',
	depositAmount: ''
};
function values(patch: Partial<QuoteFormValues> = {}): QuoteFormValues {
	return {
		deposit,
		service: null,
		overrides: [],
		adjustments: [],
		reviewToken: '',
		reviewedBasis: '',
		reviewedFingerprint: '',
		...patch
	};
}
function form(entries: [string, string][]) {
	const data = new FormData();
	for (const [key, value] of [
		['expectedVersion', '1'],
		['depositChoice', 'suggested'],
		['reviewedSuggestionType', 'PERCENTAGE'],
		['reviewedSuggestionValue', '20'],
		...entries
	])
		data.append(key, value);
	return data;
}
const maya = requestFixtures()[mayaId];
const service = {
	catalogRevision: '15',
	guestCount: '40',
	guestCountIsMinimum: false,
	durationMinutes: '90',
	selections: maya.inquiry.pricingInputs.selections
};

describe('builder choices', () => {
	it('takes names and limits from the catalog and durations from the form', () => {
		const choices = builderChoices(offeringCatalog(), inquiryForm());
		expect(choices).toMatchObject({
			catalogRevision: 15,
			guestMinimum: 1,
			durations: [
				{ value: 90, label: '1½ hours' },
				{ value: 120, label: '2 hours' },
				{ value: 150, label: '2½ hours' },
				{ value: 180, label: '3 hours' }
			]
		});
		expect(choices!.categories.map((c) => [c.label, c.minSelections, c.maxSelections])).toEqual([
			['Soft serve', 1, 2],
			['Hand-scooped', 4, 4],
			['Toppings', 4, 6],
			['Cones & cups', 1, 1]
		]);
		const scooped = choices!.categories[1].options;
		expect(scooped.map((o) => o.key)).not.toContain('hand-scooped-rocky-road');
		expect(scooped.find((o) => o.key === 'hand-scooped-butter-pecan')?.availability).toBe(
			'UNAVAILABLE'
		);
	});
	it('is unavailable without durations, a guest question or a well-formed catalog', () => {
		const noDuration = inquiryForm();
		noDuration.sections[0].fields.pop();
		expect(builderChoices(offeringCatalog(), noDuration)).toBeNull();
		expect(builderChoices({ revision: 1 }, inquiryForm())).toBeNull();
		expect(builderChoices(offeringCatalog(), null)).toBeNull();
	});
});

describe('override targets', () => {
	it.each<QuoteOverrideTarget>([
		{ type: 'EXISTING_LINE', lineItemId: '20000000-0000-0000-0000-000000000001' },
		{ type: 'BASE_SERVICE' },
		{ type: 'ICE_CREAM_SERVICE' },
		{ type: 'EXTRA_TOPPINGS' },
		{ type: 'SELECTED_OFFERING', category: 'cone:option', offering: 'waffle cone' }
	])('round-trips %j through a field-name key', (target) => {
		expect(parseTargetKey(targetKey(target))).toEqual(target);
	});
	it.each(['EXISTING_LINE:not-a-uuid', 'SELECTED_OFFERING:a', 'OTHER', 'SELECTED_OFFERING:%E0:x'])(
		'rejects %s',
		(key) => expect(parseTargetKey(key)).toBeNull()
	);
});

describe('reading the posted builder form', () => {
	it('keeps exact strings and the posted order of categories, picks and added lines', () => {
		const read = readQuoteForm(
			form([
				['service', '1'],
				['catalogRevision', '15'],
				['category', 'b'],
				['category', 'a'],
				['guestCount', ' 40 '],
				['guestCountIsMinimum', 'on'],
				['durationMinutes', '90'],
				['pick:a', 'y'],
				['pick:a', 'x'],
				['adjustment', 'k2'],
				['adjustment:kind:k2', 'CREDIT'],
				['adjustment:amount:k2', '10.50'],
				['adjustment', 'k1'],
				['adjustment:kind:k1', 'CHARGE']
			])
		);
		expect(read?.service).toEqual({
			catalogRevision: '15',
			guestCount: '40',
			guestCountIsMinimum: true,
			durationMinutes: '90',
			selections: [
				{ category: 'b', offerings: [] },
				{ category: 'a', offerings: ['y', 'x'] }
			]
		});
		expect(read?.adjustments.map((a) => [a.clientKey, a.kind, a.amount])).toEqual([
			['k2', 'CREDIT', '10.50'],
			['k1', 'CHARGE', '']
		]);
	});
	it.each([
		['a file field', (data: FormData) => data.append('note', new Blob(['x']))],
		[
			'a duplicate pick',
			(data: FormData) => {
				data.append('service', '1');
				data.append('catalogRevision', '15');
				data.append('category', 'a');
				data.append('pick:a', 'x');
				data.append('pick:a', 'x');
			}
		],
		[
			'adjustment fields for an undeclared row',
			(data: FormData) => data.append('adjustment:amount:ghost', '1')
		],
		[
			'an override without its original',
			(data: FormData) => data.append('override:amount:BASE_SERVICE', '1')
		],
		['a malformed review token', (data: FormData) => data.append('reviewToken', 'abc')],
		['an unknown basis', (data: FormData) => data.append('reviewedBasis', 'FREE')]
	] as [string, (data: FormData) => void][])('rejects %s', (_name, mutate) => {
		const data = form([]);
		mutate(data);
		expect(readQuoteForm(data)).toBeNull();
	});
});

describe('local input checks', () => {
	it('ignores untouched blank rows and unchanged line amounts', () => {
		expect(
			quoteInputErrors(
				values({
					overrides: [{ key: 'BASE_SERVICE', amount: '205.0', original: '205.00', reason: '' }],
					adjustments: [
						{ clientKey: 'k', kind: 'CHARGE', description: ' ', detail: '', amount: '', reason: '' }
					]
				}),
				'USD'
			)
		).toEqual({});
	});
	it('names the field of every incomplete change', () => {
		expect(
			Object.keys(
				quoteInputErrors(
					values({
						service: { ...service, guestCount: '0', durationMinutes: '' },
						overrides: [{ key: 'BASE_SERVICE', amount: '-1', original: '205.00', reason: '' }],
						adjustments: [
							{
								clientKey: 'k',
								kind: 'DISCOUNT',
								description: 'Off',
								detail: '',
								amount: '1.001',
								reason: ''
							}
						]
					}),
					'USD'
				)
			).sort()
		).toEqual([
			'adjustment:amount:k',
			'adjustment:reason:k',
			'durationMinutes',
			'guestCount',
			'override:amount:BASE_SERVICE',
			'override:reason:BASE_SERVICE'
		]);
	});
	it('treats an exact-value match at any scale as unchanged', () => {
		expect(
			isActiveOverride({ key: 'k', amount: '160', original: '160.00', reason: '' }, 'USD')
		).toBe(false);
		expect(
			isActiveOverride({ key: 'k', amount: '160.01', original: '160.00', reason: '' }, 'USD')
		).toBe(true);
	});
});

describe('pricing mode', () => {
	const effective = maya.inquiry.pricingInputs;
	it('derives the effective configuration only from known pricing sources', () => {
		expect(effectiveConfiguration(maya)).toBe(maya.inquiry.pricingInputs);
		const later = requestFixtures()[mayaId];
		later.financial.version = 2;
		expect(effectiveConfiguration(later)).toBeNull();
		later.financial.pricing = { ...effective, guestCount: 50 };
		expect(effectiveConfiguration(later)?.guestCount).toBe(50);
	});
	it('keeps, revises or reprices from what changed', () => {
		expect(chooseBasis(null, effective)).toBe('KEEP_ESTIMATE');
		expect(chooseBasis(service, null)).toBe('KEEP_ESTIMATE');
		expect(
			chooseBasis(
				{
					...service,
					selections: [...service.selections]
						.reverse()
						.map((s) => ({ ...s, offerings: [...s.offerings].reverse() }))
				},
				effective
			)
		).toBe('KEEP_ESTIMATE');
		const swapped = service.selections.map((s) =>
			s.category === 'topping'
				? { ...s, offerings: ['sprinkles', 'oreos', 'strawberries', 'hot-fudge'] }
				: s
		);
		expect(chooseBasis({ ...service, selections: swapped }, effective)).toBe(
			'REVISE_SERVICE_SELECTIONS'
		);
		expect(chooseBasis({ ...service, durationMinutes: '120' }, effective)).toBe(
			'REPRICE_CONFIGURATION'
		);
		expect(chooseBasis({ ...service, guestCountIsMinimum: true }, effective)).toBe(
			'REPRICE_CONFIGURATION'
		);
	});
	it('accepts a reprice review for edits that read as a revision, never the reverse', () => {
		expect(basisStillReviewed('REPRICE_CONFIGURATION', 'REVISE_SERVICE_SELECTIONS')).toBe(true);
		expect(basisStillReviewed('REVISE_SERVICE_SELECTIONS', 'REPRICE_CONFIGURATION')).toBe(false);
		expect(basisStillReviewed('KEEP_ESTIMATE', 'REVISE_SERVICE_SELECTIONS')).toBe(false);
		expect(basisStillReviewed('', 'KEEP_ESTIMATE')).toBe(false);
	});
	it('keeps only source overrides for selected offerings when repricing', () => {
		const { composition, clearedOverrides } = buildComposition(
			values({
				service,
				overrides: [
					{ key: 'BASE_SERVICE', amount: '200', original: '205.00', reason: 'Neighbor' },
					{
						key: targetKey({
							type: 'SELECTED_OFFERING',
							category: 'cone-option',
							offering: 'waffle-cone'
						}),
						amount: '20',
						original: '30.00',
						reason: 'Promo'
					},
					{
						key: targetKey({
							type: 'SELECTED_OFFERING',
							category: 'soft-serve-flavor',
							offering: 'horchata'
						}),
						amount: '0',
						original: '20.00',
						reason: 'Gone'
					},
					{
						key: 'EXISTING_LINE:20000000-0000-0000-0000-000000000001',
						amount: '1',
						original: '205.00',
						reason: 'Old'
					}
				]
			}),
			'REPRICE_CONFIGURATION',
			'USD'
		);
		expect(clearedOverrides).toBe(true);
		expect(composition.pricing).toMatchObject({ mode: 'REPRICE_CONFIGURATION', guestCount: 40 });
		expect(composition.overrides?.map((o) => o.target)).toEqual([
			{ type: 'BASE_SERVICE' },
			{ type: 'SELECTED_OFFERING', category: 'cone-option', offering: 'waffle-cone' }
		]);
	});
	it('never names a configuration when the Estimate is kept', () => {
		expect(buildComposition(values({ service }), 'KEEP_ESTIMATE', 'USD')).toEqual({
			composition: { pricing: { mode: 'KEEP_ESTIMATE' } },
			clearedOverrides: false
		});
	});
});

describe('preview presentation', () => {
	const line: QuotePreviewLine = {
		lineItemId: '20000000-0000-0000-0000-000000000002',
		origin: { type: 'ESTIMATE_LINE' },
		description: 'Ice cream service',
		unitPrice: '145.00',
		subtotal: '145.00',
		taxAmount: '0.00',
		total: '145.00',
		currency: 'USD',
		override: {
			reason: 'Package',
			originalQuantity: '40',
			originalUnitPrice: '4.00',
			originalTotal: '160.00'
		}
	};
	const preview = {
		inquiryId: mayaId,
		documentId: maya.financial.id,
		reviewedDocumentVersion: 1,
		estimateTotal: '440.00',
		pricingBasis: 'KEEP_ESTIMATE',
		catalogRevision: 15,
		financialChange: true,
		quoteVersion: 3,
		service: { guestCount: 40, guestCountIsMinimum: false, durationMinutes: 120, selections: [] },
		lines: [line],
		subtotal: '430.00',
		taxAmount: '0.00',
		total: '430.00',
		currency: 'USD',
		deposit: {
			terms: { type: 'FIXED', amount: '105.00', currency: 'USD' },
			requiredAmount: { amount: '105.00', currency: 'USD' }
		},
		reviewToken: 'd0bf75539c59600ceb1d6a29afd5fe38b6a2c6b1b613bd02e9f024f4f25ba98f'
	};
	it('accepts a coherent preview and rejects one for another request or currency', () => {
		expect(isQuotePreview(preview, maya)).toBe(true);
		expect(isQuotePreview({ ...preview, documentId: 'other' }, maya)).toBe(false);
		expect(isQuotePreview({ ...preview, currency: 'CAD' }, maya)).toBe(false);
		expect(isQuotePreview({ ...preview, reviewToken: 'ABC' }, maya)).toBe(false);
		expect(isQuotePreview({ ...preview, pricingBasis: 'GUESS' }, maya)).toBe(false);
		expect(
			isQuotePreview({ ...preview, lines: [{ ...line, origin: { type: 'MYSTERY' } }] }, maya)
		).toBe(false);
	});
	it('describes the original price of an overridden line', () => {
		expect(overrideOriginalLabel(line)).toBe('Was $160 · 40 × $4');
		expect(overrideOriginalLabel({ ...line, override: undefined })).toBeNull();
	});
	it('groups violation copy by section with a safe fallback', () => {
		expect(
			quoteViolationFeedback(['OVERRIDE_UNCHANGED', 'TOO_MANY_SELECTIONS', 'SOMETHING_NEW'])
		).toEqual({
			lines: [expect.stringContaining('matches its original')],
			service: [expect.stringContaining('more picks than it allows')],
			form: [expect.stringContaining('couldn’t be accepted')]
		});
		expect(quoteViolationFeedback([])).toEqual({ form: [expect.any(String)] });
	});
	it('summarizes pick changes by name', () => {
		const name = (_category: string, key: string) => key.toUpperCase();
		expect(
			picksDiff(
				[{ category: 'a', offerings: ['x', 'z'] }],
				[{ category: 'a', offerings: ['x', 'y'] }],
				name
			)
		).toBe('Changed from their estimate — added Z · removed Y.');
		expect(
			picksDiff([{ category: 'a', offerings: ['x'] }], [{ category: 'a', offerings: ['x'] }], name)
		).toBe('');
	});
});
