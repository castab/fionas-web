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
	price?: OfferingOption['price'],
	availability: OfferingOption['availability'] = 'AVAILABLE'
): OfferingOption => ({
	key,
	category,
	displayName: key,
	selectionState: 'ENABLED',
	availability,
	...(price ? { price } : {})
});

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

// Mirrors the commerce API's documented example so the arithmetic can be checked against it. All
// amounts are fixture values, not any real catalog revision's prices.
const form: InquiryForm = {
	definitionVersion: 7,
	catalogId: 'c',
	catalogRevision: 15,
	sections: [
		{
			key: 'service',
			title: 'Service',
			optional: false,
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
					}),
					// Listed, priced, but temporarily unavailable: it can never add to the estimate.
					offering(
						'soft-serve-flavor',
						'ube',
						{ kind: 'PER_QUANTITY', amount: '1.00', currency: 'USD', dimension: 'guest' },
						'UNAVAILABLE'
					)
				]),
				choice('topping', 4, 6, [
					...['sprinkles', 'oreos', 'strawberries', 'brownies', 'gummy-bears', 'cookie-dough'].map(
						(key) => offering('topping', key)
					),
					offering('topping', 'mochi', undefined, 'UNAVAILABLE')
				]),
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

	it('returns null without the basics or for a duration the preview does not price', () => {
		expect(computeAdvisoryEstimate(form, emptyAnswers(form))).toBeNull();
		const answers = answered(four);
		answers.values.durationMinutes = '90';
		expect(computeAdvisoryEstimate(form, answers)).toBeNull();
	});

	it('itemises base service once and the per-guest service rate times guests', () => {
		const answers = emptyAnswers(form);
		answers.values.guestCount = '10';
		answers.values.durationMinutes = '150';
		expect(
			computeAdvisoryEstimate(form, answers)?.lines.map((l) => [
				l.description,
				l.quantity,
				l.unitPrice,
				l.subtotal
			])
		).toEqual([
			['Base service', undefined, '275.00', '275.00'],
			['Ice cream service', '10', '4.00', '40.00']
		]);
	});

	it('never counts an unavailable option, even if one reaches the answers', () => {
		const answers = answered([...four, 'gummy-bears', 'mochi']);
		answers.values['offering:soft-serve-flavor'] = ['vanilla', 'horchata', 'ube'];
		const estimate = computeAdvisoryEstimate(form, answers);
		expect(estimate?.lines.map((l) => l.description)).not.toContain('ube');
		// Only gummy bears counts as an extra topping: 643.75 + 1 * 75 * 0.25.
		expect(estimate?.lines.find((l) => l.description.startsWith('Extra'))?.description).toBe(
			'Extra toppings (1)'
		);
		expect(estimate?.total).toBe('662.50');
	});

	it('adds money exactly where binary floating point would drift', () => {
		const cents = JSON.parse(JSON.stringify(form)) as InquiryForm;
		cents.pricingPreview.perGuestAmount = '0.20';
		cents.pricingPreview.durationOptions[0]!.baseServiceAmount = '0.10';
		const answers = emptyAnswers(cents);
		answers.values.guestCount = '1';
		answers.values.durationMinutes = '120';
		expect(0.1 + 0.2).not.toBe(0.3);
		expect(computeAdvisoryEstimate(cents, answers)?.total).toBe('0.30');
	});

	it('multiplies per-guest offering prices exactly', () => {
		const cents = JSON.parse(JSON.stringify(form)) as InquiryForm;
		cents.pricingPreview.perGuestAmount = '0.00';
		cents.pricingPreview.durationOptions[0]!.baseServiceAmount = '0.00';
		const flavors = cents.sections[0]!.fields.find((f) => f.key === 'offering:soft-serve-flavor')!;
		if (flavors.input.type === 'OFFERING_CHOICE') {
			flavors.input.options[1]!.price = {
				kind: 'PER_QUANTITY',
				amount: '0.07',
				currency: 'USD',
				dimension: 'guest'
			};
		}
		const answers = emptyAnswers(cents);
		answers.values.guestCount = '100';
		answers.values.durationMinutes = '120';
		answers.values['offering:soft-serve-flavor'] = ['horchata'];
		expect(0.07 * 100).not.toBe(7);
		const estimate = computeAdvisoryEstimate(cents, answers);
		expect(estimate?.lines.find((l) => l.description === 'horchata')?.subtotal).toBe('7.00');
		expect(estimate?.total).toBe('7.00');
	});

	it("labels the base service with the duration question's own label", () => {
		const base = computeAdvisoryEstimate(form, answered(four))?.lines[0];
		expect(base?.subDescription).toBe('120 minutes');

		const fractional = JSON.parse(JSON.stringify(form)) as InquiryForm;
		const duration = fractional.sections[0]!.fields.find((f) => f.key === 'durationMinutes')!;
		if (duration.input.type === 'INTEGER_CHOICE') duration.input.options[0]!.label = '2 hours';
		const answers = answered(four);
		expect(computeAdvisoryEstimate(fractional, answers)?.lines[0]?.subDescription).toBe('2 hours');

		// A duration asked as a plain number has no label: fall back to minutes.
		duration.input = { type: 'INTEGER', minimum: 1 };
		expect(computeAdvisoryEstimate(fractional, answers)?.lines[0]?.subDescription).toBe(
			'120 minutes'
		);
	});

	it('prefers line wording the backend supplies, ignoring null or blank text', () => {
		const worded = JSON.parse(JSON.stringify(form)) as InquiryForm;
		const preview = worded.pricingPreview;
		preview.baseServiceDescription = 'Trailer visit';
		preview.perGuestDescription = '   ';
		preview.durationOptions[0]!.baseServiceSubDescription = '2 hours · setup & travel';
		preview.toppingAdjustment.description = 'More toppings';
		preview.toppingAdjustment.subDescription = null;
		const estimate = computeAdvisoryEstimate(worded, answered([...four, 'gummy-bears']));
		expect(estimate?.lines.map((l) => [l.description, l.subDescription])).toEqual([
			['Trailer visit', '2 hours · setup & travel'],
			['Ice cream service', '75 guests'],
			['horchata', undefined],
			['waffle-cone', undefined],
			['More toppings (1)', '4 toppings included; each extra is charged per guest']
		]);
		// Wording never changes the arithmetic.
		expect(estimate?.total).toBe(
			computeAdvisoryEstimate(form, answered([...four, 'gummy-bears']))?.total
		);
	});
});
