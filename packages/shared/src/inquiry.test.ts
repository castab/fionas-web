import { describe, expect, it } from 'vitest';
import {
	answersFromFormData,
	buildInquiryRequest,
	CATALOG_STATE_VIOLATIONS,
	clearSection,
	describeViolation,
	emptyAnswers,
	formatOfferingPrice,
	hasPricingBasics,
	isEstimateReady,
	isSectionInUse,
	isSelectable,
	reconcileAnswers,
	validateAnswers,
	type InquiryForm,
	type OfferingOption
} from './inquiry.ts';

const flavor = (
	key: string,
	displayName: string,
	availability: OfferingOption['availability'] = 'AVAILABLE'
): OfferingOption => ({
	key,
	category: 'soft-serve-flavor',
	displayName,
	selectionState: 'ENABLED',
	availability
});

const form: InquiryForm = {
	definitionVersion: 6,
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
							flavor('vanilla', 'Vanilla'),
							flavor('chocolate', 'Chocolate'),
							flavor('horchata', 'Horchata'),
							flavor('mango', 'Mango', 'UNAVAILABLE')
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
	],
	pricingPreview: {
		currency: 'USD',
		guestQuantityDimension: 'guest',
		durationOptions: [],
		perGuestAmount: '1.00',
		toppingAdjustment: {
			category: 'topping',
			includedSelections: 0,
			additionalSelectionPerGuestAmount: '0.00'
		}
	}
};

const serviceSection = () => form.sections.find((s) => s.key === 'service')!;

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
	it('flags missing contact details but lets the optional service section be skipped', () => {
		const errors = validateAnswers(form, emptyAnswers(form));
		expect(Object.keys(errors).sort()).toEqual(['email', 'name']);
	});

	it('applies every service requirement once the customer starts that section', () => {
		const answers = emptyAnswers(form);
		answers.values.name = 'Jane';
		answers.values.email = 'jane@example.com';
		answers.values.guestCount = '75';
		expect(Object.keys(validateAnswers(form, answers)).sort()).toEqual([
			'durationMinutes',
			'offering:soft-serve-flavor'
		]);
	});

	it('refuses an unavailable choice by name, without dropping it silently', () => {
		const answers = answered();
		answers.values['offering:soft-serve-flavor'] = ['mango'];
		expect(validateAnswers(form, answers)['offering:soft-serve-flavor']).toBe(
			'Mango is unavailable right now — please choose another.'
		);
		expect(answers.values['offering:soft-serve-flavor']).toEqual(['mango']);
	});

	it('refuses a choice the form does not list', () => {
		const answers = answered();
		answers.values['offering:soft-serve-flavor'] = ['pistachio'];
		expect(validateAnswers(form, answers)['offering:soft-serve-flavor']).toMatch(/no longer/);
	});

	it('rejects a malformed email', () => {
		const answers = answered();
		answers.values.email = 'jane@';
		expect(validateAnswers(form, answers).email).toBeDefined();
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

	it('sends a plain inquiry, without pricingInputs, when the service section is skipped', () => {
		const answers = emptyAnswers(form);
		answers.values.name = 'Jane';
		answers.values.email = 'jane@example.com';
		answers.values.message = 'Can we talk about a school event?';
		expect(validateAnswers(form, answers)).toEqual({});
		expect(buildInquiryRequest(form, answers)).toEqual({
			name: 'Jane',
			email: 'jane@example.com',
			message: 'Can we talk about a school event?'
		});
	});
});

describe('optional sections', () => {
	it('counts a section as started only once a non-checkbox question is answered', () => {
		const answers = emptyAnswers(form);
		answers.values.guestCountIsMinimum = true;
		expect(isSectionInUse(serviceSection(), answers)).toBe(false);
		answers.values['offering:soft-serve-flavor'] = ['vanilla'];
		expect(isSectionInUse(serviceSection(), answers)).toBe(true);
	});

	it('clears a section back to a plain inquiry, leaving other answers alone', () => {
		const cleared = clearSection(form, serviceSection(), answered());
		expect(cleared.values.name).toBe('  Jane Doe ');
		expect(cleared.values.guestCount).toBe('');
		expect(cleared.values['offering:soft-serve-flavor']).toEqual([]);
		expect(buildInquiryRequest(form, cleared).pricingInputs).toBeUndefined();
	});
});

describe('isSelectable', () => {
	it('allows only enabled, available offerings', () => {
		expect(isSelectable(flavor('vanilla', 'Vanilla'))).toBe(true);
		expect(isSelectable(flavor('mango', 'Mango', 'UNAVAILABLE'))).toBe(false);
		expect(isSelectable({ ...flavor('x', 'X'), selectionState: 'DISABLED' })).toBe(false);
	});
});

describe('reconcileAnswers', () => {
	/** The same form after a catalog publication: Horchata retired, at most one flavor, 150 min added. */
	function republished(): InquiryForm {
		const next = JSON.parse(JSON.stringify(form)) as InquiryForm;
		next.catalogRevision = 16;
		for (const field of next.sections.flatMap((s) => s.fields)) {
			if (field.input.type === 'OFFERING_CHOICE') {
				field.input.maxSelections = 1;
				field.input.options = field.input.options.filter((o) => o.key !== 'horchata');
			}
		}
		return next;
	}

	it('keeps every answer and flags nothing when the form is unchanged', () => {
		const answers = answered();
		answers.values.guestCountIsMinimum = true;
		expect(reconcileAnswers(form, answers)).toEqual({ answers, changed: [], unavailable: [] });
	});

	it('keeps contact details but drops a retired choice instead of substituting one', () => {
		const { answers, changed } = reconcileAnswers(republished(), answered());
		expect(answers.values.name).toBe('  Jane Doe ');
		expect(answers.values.email).toBe('jane@example.com');
		expect(answers.values.guestCount).toBe('75');
		expect(answers.values['offering:soft-serve-flavor']).toEqual(['vanilla']);
		expect(changed).toEqual(['offering:soft-serve-flavor']);
	});

	it('unselects a choice that became unavailable, keeps it listed and names it', () => {
		const next = republished();
		for (const field of next.sections.flatMap((s) => s.fields)) {
			if (field.input.type === 'OFFERING_CHOICE') {
				field.input.maxSelections = 2;
				field.input.options = [
					flavor('vanilla', 'Vanilla'),
					flavor('chocolate', 'Chocolate'),
					flavor('horchata', 'Horchata', 'UNAVAILABLE')
				];
			}
		}
		const previous = answered();
		previous.values['offering:soft-serve-flavor'] = ['horchata'];
		const { answers, changed, unavailable } = reconcileAnswers(next, previous);
		// Nothing substituted: the list is empty and the minimum now asks for a new choice.
		expect(answers.values['offering:soft-serve-flavor']).toEqual([]);
		expect(unavailable).toEqual(['Horchata']);
		expect(changed).toEqual(['offering:soft-serve-flavor']);
		expect(answers.values.guestCount).toBe('75');
		expect(validateAnswers(next, answers)['offering:soft-serve-flavor']).toMatch(/at least 1/);
	});

	it('flags a pick list that no longer fits its limits without trimming it', () => {
		const answers = answered();
		answers.values['offering:soft-serve-flavor'] = ['vanilla', 'chocolate'];
		const result = reconcileAnswers(republished(), answers);
		expect(result.answers.values['offering:soft-serve-flavor']).toEqual(['vanilla', 'chocolate']);
		expect(result.changed).toEqual(['offering:soft-serve-flavor']);
		expect(validateAnswers(republished(), result.answers)['offering:soft-serve-flavor']).toMatch(
			/no more than 1/
		);
	});

	it('clears a choice the new form no longer lists', () => {
		const next = republished();
		const duration = next.sections[1]!.fields.find((f) => f.key === 'durationMinutes')!;
		if (duration.input.type === 'INTEGER_CHOICE')
			duration.input.options = [{ value: 90, label: '90' }];
		const { answers, changed } = reconcileAnswers(next, answered());
		expect(answers.values.durationMinutes).toBe('');
		expect(changed).toContain('durationMinutes');
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
		expect(describeViolation('OFFERING_UNAVAILABLE')).toMatch(/unavailable right now/);
		expect(describeViolation('OFFERING_DISABLED')).toMatch(/no longer on our menu/);
		expect(describeViolation('SOMETHING_NEW')).toMatch(/review/);
	});

	it('knows which violations mean the options on the page are out of date', () => {
		expect([...CATALOG_STATE_VIOLATIONS].sort()).toEqual([
			'OFFERING_DISABLED',
			'OFFERING_UNAVAILABLE',
			'PUBLIC_INQUIRY_CATEGORY_NOT_ALLOWED',
			'UNKNOWN_OFFERING'
		]);
		expect(CATALOG_STATE_VIOLATIONS.has('INVALID_GUEST_COUNT')).toBe(false);
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
