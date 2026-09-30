import { describe, expect, it } from 'vitest';
import { computeAdvisoryEstimate } from './estimate.ts';
import {
	emptyAnswers,
	type InquiryForm,
	type InquiryFormField,
	type OfferingOption
} from './inquiry.ts';

const offering = (
	category: string,
	key: string,
	price?: OfferingOption['price']
): OfferingOption => ({ key, category, displayName: key, ...(price ? { price } : {}) });

const choice = (
	category: string,
	min: number,
	max: number | undefined,
	options: OfferingOption[]
): InquiryFormField => ({
	key: `offering:${category}`,
	label: category,
	submissionPointer: '/pricingInputs/selections',
	required: min > 0,
	input: { type: 'OFFERING_CHOICE', category, minSelections: min, maxSelections: max, options },
	presentation: { control: 'CARDS' }
});

// Mirrors the commerce API's documented example so the arithmetic can be checked against it.
const form: InquiryForm = {
	definitionVersion: 2,
	catalogId: 'c',
	catalogRevision: 15,
	sections: [
		{
			key: 'service',
			title: 'Service',
			optional: true,
			fields: [
				{
					key: 'guestCount',
					label: 'Guests',
					submissionPointer: '/pricingInputs/guestCount',
					required: true,
					input: { type: 'INTEGER', minimum: 1 },
					presentation: { control: 'NUMBER' }
				},
				{
					key: 'guestCountIsMinimum',
					label: 'Minimum',
					submissionPointer: '/pricingInputs/guestCountIsMinimum',
					required: false,
					input: { type: 'BOOLEAN', defaultValue: false },
					presentation: { control: 'CHECKBOX' }
				},
				{
					key: 'durationMinutes',
					label: 'Duration',
					submissionPointer: '/pricingInputs/durationMinutes',
					required: true,
					input: {
						type: 'INTEGER_CHOICE',
						options: [
							{ value: 120, label: '120 minutes' },
							{ value: 150, label: '150 minutes' }
						]
					},
					presentation: { control: 'SELECT' }
				},
				choice('soft-serve-flavor', 1, 2, [
					offering('soft-serve-flavor', 'vanilla'),
					offering('soft-serve-flavor', 'horchata', {
						kind: 'PER_QUANTITY',
						amount: '0.50',
						currency: 'USD',
						dimension: 'guest'
					})
				]),
				choice(
					'topping',
					4,
					6,
					['sprinkles', 'oreos', 'strawberries', 'brownies', 'gummy-bears', 'cookie-dough'].map(
						(key) => offering('topping', key)
					)
				),
				choice('cone-option', 1, 1, [
					offering('cone-option', 'cup'),
					offering('cone-option', 'waffle-cone', {
						kind: 'PER_QUANTITY',
						amount: '0.75',
						currency: 'USD',
						dimension: 'guest'
					}),
					offering('cone-option', 'fancy', { kind: 'FIXED', amount: '20.00', currency: 'USD' }),
					offering('cone-option', 'hourly', {
						kind: 'PER_DURATION',
						amount: '50.00',
						currency: 'USD',
						interval: 'PT1H'
					})
				])
			]
		}
	],
	pricingPreview: {
		currency: 'USD',
		guestQuantityDimension: 'guest',
		durationOptions: [
			{
				durationMinutes: 120,
				baseServiceAmount: '250.00',
				offeringContributions: [{ offeringKey: 'hourly', amount: '100.00' }]
			},
			{ durationMinutes: 150, baseServiceAmount: '275.000', offeringContributions: [] }
		],
		perGuestAmount: '4.00',
		toppingAdjustment: {
			category: 'topping',
			includedSelections: 4,
			additionalSelectionPerGuestAmount: '0.25'
		}
	}
};

function answered(toppings: string[], cone = 'waffle-cone') {
	const answers = emptyAnswers(form);
	answers.values.guestCount = '75';
	answers.values.durationMinutes = '120';
	answers.values['offering:soft-serve-flavor'] = ['vanilla', 'horchata'];
	answers.values['offering:topping'] = toppings;
	answers.values['offering:cone-option'] = [cone];
	return answers;
}

const four = ['sprinkles', 'oreos', 'strawberries', 'brownies'];

describe('computeAdvisoryEstimate', () => {
	it("matches the API's documented estimate for the same choices", () => {
		// 250 base + 300 service + 37.50 horchata + 56.25 cones + 2 extra toppings * 75 * 0.25
		const estimate = computeAdvisoryEstimate(
			form,
			answered([...four, 'gummy-bears', 'cookie-dough'])
		);
		expect(estimate?.total).toBe('681.25');
		expect(estimate?.lines.map((l) => [l.description, l.subtotal])).toEqual([
			['Base service', '250.00'],
			['Ice cream service', '300.00'],
			['horchata', '37.50'],
			['waffle-cone', '56.25'],
			['Extra toppings (2)', '37.50']
		]);
	});

	it('charges no extra toppings within the included count', () => {
		const estimate = computeAdvisoryEstimate(form, answered(four));
		expect(estimate?.total).toBe('643.75');
		expect(estimate?.lines.some((l) => l.description.startsWith('Extra toppings'))).toBe(false);
	});

	it('adds FIXED once and PER_DURATION from the duration-specific contribution', () => {
		expect(computeAdvisoryEstimate(form, answered(four, 'fancy'))?.total).toBe('607.50');
		expect(computeAdvisoryEstimate(form, answered(four, 'hourly'))?.total).toBe('687.50');
	});

	it('uses the selected duration and keeps three-decimal amounts exact', () => {
		const answers = answered(four, 'cup');
		answers.values.durationMinutes = '150';
		answers.values['offering:soft-serve-flavor'] = ['vanilla'];
		expect(computeAdvisoryEstimate(form, answers)?.total).toBe('575.00');
	});

	it('flags a minimum guest count as a starting price', () => {
		const answers = answered(four);
		answers.values.guestCountIsMinimum = true;
		expect(computeAdvisoryEstimate(form, answers)?.guestCountIsMinimum).toBe(true);
	});

	it('gives an estimate so far once guests and duration are known', () => {
		const answers = emptyAnswers(form);
		answers.values.guestCount = '25';
		answers.values.durationMinutes = '120';
		expect(computeAdvisoryEstimate(form, answers)?.total).toBe('350.00');

		// Each pick adds its own line as it is chosen.
		answers.values['offering:soft-serve-flavor'] = ['horchata'];
		expect(computeAdvisoryEstimate(form, answers)?.total).toBe('362.50');
	});

	it('returns null without the basics or without pricingPreview', () => {
		expect(computeAdvisoryEstimate(form, emptyAnswers(form))).toBeNull();
		expect(
			computeAdvisoryEstimate({ ...form, pricingPreview: undefined }, answered(four))
		).toBeNull();
	});
});
