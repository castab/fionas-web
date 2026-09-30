import { describe, expect, it } from 'vitest';
import {
	answersFromFormData,
	buildInquiryRequest,
	describeViolation,
	emptyAnswers,
	formatOfferingPrice,
	hasPricingBasics,
	isEstimateReady,
	validateAnswers,
	type InquiryForm
} from './inquiry.ts';

const form: InquiryForm = {
	definitionVersion: 1,
	catalogId: '0cde8e0b-aa9c-4129-9853-8db2cbbb909b',
	catalogRevision: 15,
	sections: [
		{
			key: 'contact',
			title: 'Contact information',
			optional: false,
			fields: [
				{
					key: 'name',
					label: 'Your name',
					submissionPointer: '/name',
					required: true,
					input: { type: 'TEXT', minLength: 1, maxLength: 200 },
					presentation: { control: 'TEXT' }
				},
				{
					key: 'email',
					label: 'Email address',
					submissionPointer: '/email',
					required: true,
					input: { type: 'EMAIL', maxLength: 254 },
					presentation: { control: 'TEXT' }
				}
			]
		},
		{
			key: 'service',
			title: 'Build your ice cream service',
			optional: true,
			fields: [
				{
					key: 'guestCount',
					label: 'How many guests?',
					submissionPointer: '/pricingInputs/guestCount',
					required: true,
					input: { type: 'INTEGER', minimum: 1 },
					presentation: { control: 'NUMBER' }
				},
				{
					key: 'guestCountIsMinimum',
					label: 'This is a minimum guest count',
					submissionPointer: '/pricingInputs/guestCountIsMinimum',
					required: false,
					input: { type: 'BOOLEAN', defaultValue: false },
					presentation: { control: 'CHECKBOX' }
				},
				{
					key: 'durationMinutes',
					label: 'How long would you like service?',
					submissionPointer: '/pricingInputs/durationMinutes',
					required: true,
					input: {
						type: 'INTEGER_CHOICE',
						options: [
							{ value: 90, label: '90 minutes' },
							{ value: 120, label: '120 minutes' }
						]
					},
					presentation: { control: 'SELECT' }
				},
				{
					key: 'offering:soft-serve-flavor',
					label: 'Choose your soft serve flavors',
					submissionPointer: '/pricingInputs/selections',
					required: true,
					input: {
						type: 'OFFERING_CHOICE',
						category: 'soft-serve-flavor',
						minSelections: 1,
						maxSelections: 2,
						options: [
							{ key: 'vanilla', category: 'soft-serve-flavor', displayName: 'Vanilla' },
							{ key: 'chocolate', category: 'soft-serve-flavor', displayName: 'Chocolate' },
							{ key: 'horchata', category: 'soft-serve-flavor', displayName: 'Horchata' }
						]
					},
					presentation: { control: 'CARDS' }
				}
			]
		},
		{
			key: 'additional',
			title: 'Additional information',
			optional: true,
			fields: [
				{
					key: 'message',
					label: 'Tell us about your event',
					submissionPointer: '/message',
					required: false,
					input: { type: 'TEXT', minLength: 0, maxLength: 4000 },
					presentation: { control: 'TEXTAREA' }
				}
			]
		}
	]
};

function answered() {
	const answers = emptyAnswers(form);
	answers.values.name = '  Jane Doe ';
	answers.values.email = 'jane@example.com';
	answers.values.guestCount = '75';
	answers.values.durationMinutes = '120';
	answers.values['offering:soft-serve-flavor'] = ['vanilla', 'horchata'];
	return answers;
}

describe('emptyAnswers', () => {
	it('starts blank, with booleans at their defaults and offerings empty', () => {
		const answers = emptyAnswers(form);
		expect(answers.values.name).toBe('');
		expect(answers.values.guestCountIsMinimum).toBe(false);
		expect(answers.values['offering:soft-serve-flavor']).toEqual([]);
	});
});

describe('validateAnswers', () => {
	it('flags every missing required field, service questions included', () => {
		const errors = validateAnswers(form, emptyAnswers(form));
		expect(Object.keys(errors).sort()).toEqual([
			'durationMinutes',
			'email',
			'guestCount',
			'name',
			'offering:soft-serve-flavor'
		]);
	});

	it('rejects a malformed email', () => {
		const answers = answered();
		answers.values.email = 'jane@';
		expect(validateAnswers(form, answers).email).toBeDefined();
	});

	it('reports only the service questions still unanswered', () => {
		const answers = emptyAnswers(form);
		answers.values.name = 'Jane';
		answers.values.email = 'jane@example.com';
		expect(Object.keys(validateAnswers(form, answers)).sort()).toEqual([
			'durationMinutes',
			'guestCount',
			'offering:soft-serve-flavor'
		]);
	});

	it('enforces integer minimums and selection limits', () => {
		const answers = answered();
		answers.values.guestCount = '0';
		answers.values['offering:soft-serve-flavor'] = ['vanilla', 'chocolate', 'horchata'];
		const errors = validateAnswers(form, answers);
		expect(errors.guestCount).toMatch(/1 or more/);
		expect(errors['offering:soft-serve-flavor']).toMatch(/no more than 2/);
	});

	it('passes a complete answer set', () => {
		expect(validateAnswers(form, answered())).toEqual({});
	});
});

describe('buildInquiryRequest', () => {
	it('maps answers by submission pointer and pins the catalog revision', () => {
		expect(buildInquiryRequest(form, answered())).toEqual({
			name: 'Jane Doe',
			email: 'jane@example.com',
			pricingInputs: {
				catalogRevision: 15,
				guestCount: 75,
				guestCountIsMinimum: false,
				durationMinutes: 120,
				selections: [{ category: 'soft-serve-flavor', offerings: ['vanilla', 'horchata'] }]
			}
		});
	});

	it('drops a blank message', () => {
		const answers = answered();
		answers.values.message = '   ';
		expect(buildInquiryRequest(form, answers).message).toBeUndefined();
	});

	it('includes a trimmed message', () => {
		const answers = answered();
		answers.values.message = ' Birthday party ';
		expect(buildInquiryRequest(form, answers).message).toBe('Birthday party');
	});
});

describe('estimates', () => {
	it('is ready only when every pricing question is valid', () => {
		const answers = answered();
		expect(isEstimateReady(form, answers)).toBe(true);
		answers.values.durationMinutes = '';
		expect(isEstimateReady(form, answers)).toBe(false);
		answers.values.durationMinutes = '120';
		answers.values['offering:soft-serve-flavor'] = [];
		expect(isEstimateReady(form, answers)).toBe(false);
		// ...but guest count and duration are enough for an "estimate so far".
		expect(hasPricingBasics(form, answers)).toBe(true);
		answers.values.guestCount = '';
		expect(hasPricingBasics(form, answers)).toBe(false);
	});
});

describe('answersFromFormData', () => {
	it('reads text, checkbox and multi-value fields', () => {
		const entries: [string, string][] = [
			['name', 'Jane'],
			['email', 'jane@example.com'],
			['guestCount', '50'],
			['guestCountIsMinimum', 'on'],
			['durationMinutes', '90'],
			['offering:soft-serve-flavor', 'vanilla'],
			['offering:soft-serve-flavor', 'chocolate']
		];
		const data = {
			get: (name: string) => entries.find(([k]) => k === name)?.[1] ?? null,
			getAll: (name: string) => entries.filter(([k]) => k === name).map(([, v]) => v)
		};
		const answers = answersFromFormData(form, data);
		expect(answers.values.guestCountIsMinimum).toBe(true);
		expect(answers.values['offering:soft-serve-flavor']).toEqual(['vanilla', 'chocolate']);
		expect(validateAnswers(form, answers)).toEqual({});
	});
});

describe('copy helpers', () => {
	it('gives friendly violation text with a generic fallback', () => {
		expect(describeViolation('TOO_MANY_SELECTIONS')).toMatch(/too many/);
		expect(describeViolation('SOMETHING_NEW')).toMatch(/review/);
	});

	it('formats offering prices', () => {
		expect(
			formatOfferingPrice({
				kind: 'PER_QUANTITY',
				amount: '0.50',
				currency: 'USD',
				dimension: 'guest'
			})
		).toBe('+$0.50/guest');
		expect(formatOfferingPrice({ kind: 'FIXED', amount: '120.00', currency: 'USD' })).toBe('+$120');
		expect(
			formatOfferingPrice({
				kind: 'PER_DURATION',
				amount: '50.00',
				currency: 'USD',
				interval: 'PT1H'
			})
		).toBe('+$50/hour');
	});
});
