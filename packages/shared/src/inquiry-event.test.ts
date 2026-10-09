import { describe, expect, it } from 'vitest';
import {
	emptyAnswers,
	isDigitsOnly,
	prepareInquiry,
	validateAnswers,
	type InquiryForm,
	type InquiryFormField
} from './inquiry.ts';

const field = (
	key: string,
	input: InquiryFormField['input'],
	control: InquiryFormField['presentation']['control'],
	required = true
): InquiryFormField => ({
	key,
	label: key,
	submissionPointer: `/${key}`,
	required,
	input,
	presentation: { control }
});

// The contact + event questions the API added in definition version 5, with the service section
// every inquiry has needed since version 7.
const form: InquiryForm = {
	definitionVersion: 7,
	priceRevision: '1',
	sections: [
		{
			key: 'contact',
			title: 'Contact',
			optional: false,
			fields: [
				field('name', { type: 'TEXT', minLength: 1, maxLength: 200 }, 'TEXT'),
				field('email', { type: 'EMAIL', maxLength: 254 }, 'TEXT'),
				field(
					'zipCode',
					{ type: 'TEXT', minLength: 5, maxLength: 5, pattern: '^[0-9]{5}$' },
					'TEXT'
				)
			]
		},
		{
			key: 'event',
			title: 'Event',
			optional: false,
			fields: [
				field('eventDate', { type: 'DATE', format: 'date' }, 'DATE'),
				field(
					'eventType',
					{
						type: 'STRING_CHOICE',
						options: [
							{ value: 'BIRTHDAY', label: 'Birthday' },
							{ value: 'OTHER', label: 'Other' }
						]
					},
					'SELECT'
				)
			]
		},
		{
			key: 'service',
			title: 'Service',
			optional: false,
			fields: [
				{
					...field('guestCount', { type: 'INTEGER', minimum: 1 }, 'NUMBER'),
					submissionPointer: '/serviceInputs/guestCount'
				},
				{
					...field(
						'durationMinutes',
						{ type: 'INTEGER_CHOICE', options: [{ value: 90, label: '90 minutes' }] },
						'SELECT'
					),
					submissionPointer: '/serviceInputs/durationMinutes'
				}
			]
		}
	],
	pricingPreview: {
		currency: 'USD',
		guestQuantityDimension: 'guest',
		durationOptions: [],
		perGuestAmount: '0.00',
		toppingAdjustment: {
			category: 'topping',
			includedSelections: 0,
			additionalSelectionPerGuestAmount: '0.00'
		}
	}
};

function answered() {
	const answers = emptyAnswers(form);
	answers.values.name = 'Jane Doe';
	answers.values.email = 'jane@example.com';
	answers.values.zipCode = '02134';
	answers.values.eventDate = '2026-12-05';
	answers.values.eventType = 'BIRTHDAY';
	answers.values.guestCount = '40';
	answers.values.durationMinutes = '90';
	return answers;
}

describe('event questions', () => {
	it('accepts a complete set of answers', () => {
		expect(validateAnswers(form, answered())).toEqual({});
	});

	it('requires the ZIP code, date and type', () => {
		const errors = validateAnswers(form, emptyAnswers(form));
		expect(Object.keys(errors)).toEqual([
			'name',
			'email',
			'zipCode',
			'eventDate',
			'eventType',
			'guestCount',
			'durationMinutes'
		]);
	});

	it('checks a ZIP code against the pattern with a plain message', () => {
		const answers = answered();
		for (const bad of ['9372', '937201', '93a20', ' ']) {
			answers.values.zipCode = bad;
			expect(validateAnswers(form, answers).zipCode).toBeDefined();
		}
		answers.values.zipCode = '9372';
		expect(validateAnswers(form, answers).zipCode).toBe('Enter 5 digits.');
		answers.values.zipCode = ' 93720 ';
		expect(validateAnswers(form, answers).zipCode).toBeUndefined();
	});

	it('only accepts real calendar dates', () => {
		const answers = answered();
		for (const bad of ['2026-02-30', '2026-13-01', '12/05/2026', '2026-1-5', 'soon']) {
			answers.values.eventDate = bad;
			expect(validateAnswers(form, answers).eventDate).toBe('Enter a valid date.');
		}
		answers.values.eventDate = '2028-02-29';
		expect(validateAnswers(form, answers).eventDate).toBeUndefined();
	});

	it('only accepts one of the offered event types', () => {
		const answers = answered();
		answers.values.eventType = 'PIRATE_PARTY';
		expect(validateAnswers(form, answers).eventType).toBe('Choose an option.');
	});

	it('submits ZIP, date and type as plain strings at their pointers', () => {
		expect(prepareInquiry(form, answered())).toEqual({
			ok: true,
			request: {
				name: 'Jane Doe',
				email: 'jane@example.com',
				zipCode: '02134',
				eventDate: '2026-12-05',
				eventType: 'BIRTHDAY',
				serviceInputs: {
					priceRevision: '1',
					guestCount: 40,
					guestCountIsMinimum: false,
					durationMinutes: 90,
					selections: []
				}
			}
		});
	});

	it('recognises digit-only patterns', () => {
		expect(isDigitsOnly('^[0-9]{5}$')).toBe(true);
		expect(isDigitsOnly('^[A-Z]{2}$')).toBe(false);
	});
});
