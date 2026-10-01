import { describe, expect, it } from 'vitest';
import {
	answersFromFormData,
	CATALOG_STATE_VIOLATIONS,
	completePricingInputs,
	describeViolation,
	draftPricingInputs,
	emptyAnswers,
	formatOfferingPrice,
	hasPricingBasics,
	isEstimateReady,
	isSelectable,
	isSkippable,
	prepareInquiry,
	pricingContractProblem,
	reconcileAnswers,
	validateAnswers,
	type InquiryAnswers,
	type InquiryCommand,
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

/** A definition version 7 form: the service section is required. Synthetic catalog. */
const form: InquiryForm = {
	definitionVersion: 7,
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
			optional: false,
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

const clone = (f: InquiryForm = form) => JSON.parse(JSON.stringify(f)) as InquiryForm;

function answered() {
	const answers = emptyAnswers(form);
	answers.values.name = '  Jane Doe ';
	answers.values.email = 'jane@example.com';
	answers.values.guestCount = '75';
	answers.values.durationMinutes = '120';
	answers.values['offering:soft-serve-flavor'] = ['vanilla', 'horchata'];
	return answers;
}

/** The answers of a customer who filled in contact details and a message, but no service. */
function contactOnly(): InquiryAnswers {
	const answers = emptyAnswers(form);
	answers.values.name = 'Jane';
	answers.values.email = 'jane@example.com';
	answers.values.message = 'Can we talk about a school event?';
	return answers;
}

/** The command's request, failing the test if there is none. */
function requestOf(command: InquiryCommand) {
	if (!command.ok) throw new Error(`expected a request, got ${JSON.stringify(command)}`);
	return command.request;
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
	it('requires contact details and the whole service configuration', () => {
		const errors = validateAnswers(form, emptyAnswers(form));
		expect(Object.keys(errors).sort()).toEqual([
			'durationMinutes',
			'email',
			'guestCount',
			'name',
			'offering:soft-serve-flavor'
		]);
	});

	it('lets the optional additional section be left blank', () => {
		const answers = answered();
		answers.values.message = '';
		expect(validateAnswers(form, answers)).toEqual({});
	});

	it('refuses an unavailable choice by name, without dropping it silently', () => {
		const answers = answered();
		answers.values['offering:soft-serve-flavor'] = ['mango'];
		expect(validateAnswers(form, answers)['offering:soft-serve-flavor']).toBe(
			'Mango is unavailable right now — please choose another.'
		);
		expect(answers.values['offering:soft-serve-flavor']).toEqual(['mango']);
	});

	it('refuses a choice the form does not list, and a choice picked twice', () => {
		const answers = answered();
		answers.values['offering:soft-serve-flavor'] = ['pistachio'];
		expect(validateAnswers(form, answers)['offering:soft-serve-flavor']).toMatch(/no longer/);
		answers.values['offering:soft-serve-flavor'] = ['vanilla', 'vanilla'];
		expect(validateAnswers(form, answers)['offering:soft-serve-flavor']).toMatch(/only once/);
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

describe('isSkippable', () => {
	const section = (key: string) => form.sections.find((s) => s.key === key)!;

	it('follows the backend: only the additional section may be omitted', () => {
		expect(isSkippable(section('contact'))).toBe(false);
		expect(isSkippable(section('service'))).toBe(false);
		expect(isSkippable(section('additional'))).toBe(true);
	});

	it('reports the backend flag as sent, never reinterpreting it', () => {
		// An optional service section is rejected as a whole (pricingContractProblem), not coerced.
		expect(isSkippable({ ...section('service'), optional: true })).toBe(true);
	});
});

describe('prepareInquiry', () => {
	it('maps answers by submission pointer and pins the catalog revision', () => {
		expect(requestOf(prepareInquiry(form, answered()))).toEqual({
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

	it('sends guestCountIsMinimum from its question, false when the form asks none', () => {
		const answers = answered();
		answers.values.guestCountIsMinimum = true;
		expect(requestOf(prepareInquiry(form, answers)).pricingInputs.guestCountIsMinimum).toBe(true);

		const withoutQuestion = clone();
		withoutQuestion.sections[1]!.fields = withoutQuestion.sections[1]!.fields.filter(
			(f) => f.key !== 'guestCountIsMinimum'
		);
		const request = requestOf(prepareInquiry(withoutQuestion, answered()));
		expect(request.pricingInputs.guestCountIsMinimum).toBe(false);
	});

	it('drops a blank message and trims a real one', () => {
		const answers = answered();
		answers.values.message = '   ';
		expect(requestOf(prepareInquiry(form, answers)).message).toBeUndefined();
		answers.values.message = ' Birthday party ';
		expect(requestOf(prepareInquiry(form, answers)).message).toBe('Birthday party');
	});

	it('never sends prices, totals or presentation data', () => {
		const text = JSON.stringify(requestOf(prepareInquiry(form, answered())));
		expect(text).not.toMatch(/amount|total|price|lines|estimate|label|displayName|options/i);
	});

	// Critical regression: there is no plain/contact-only inquiry any more (definition version 7).
	describe('no inquiry without configured ice cream service', () => {
		it('refuses contact details and a message alone', () => {
			expect(prepareInquiry(form, contactOnly())).toEqual({
				ok: false,
				reason: 'invalid',
				errors: {
					guestCount: 'This field is required.',
					durationMinutes: 'Choose an option.',
					'offering:soft-serve-flavor': 'Choose at least 1.'
				}
			});
		});

		it('rejects a definition that marks the service section optional, whatever the answers', () => {
			const drifted = clone();
			drifted.sections[1]!.optional = true;
			const rejected = {
				ok: false,
				reason: 'unpriceable',
				problem: 'section "service" has pricing questions but is marked optional'
			};
			// Not coerced into a required section: even complete answers produce no request.
			expect(prepareInquiry(drifted, contactOnly())).toEqual(rejected);
			expect(prepareInquiry(drifted, answered())).toEqual(rejected);
		});

		it.each([
			['guest count', { guestCount: '' }],
			['duration', { durationMinutes: '' }],
			['required offering picks', { 'offering:soft-serve-flavor': [] }],
			['a whole-number guest count', { guestCount: '12.5' }],
			['a listed duration', { durationMinutes: '95' }]
		])('refuses a request missing %s', (_, change) => {
			const answers = answered();
			Object.assign(answers.values, change);
			expect(prepareInquiry(form, answers).ok).toBe(false);
		});

		it('refuses a form that cannot produce pricingInputs, whatever the answers', () => {
			const noService = clone();
			noService.sections = noService.sections.filter((s) => s.key !== 'service');
			expect(prepareInquiry(noService, contactOnly())).toEqual({
				ok: false,
				reason: 'unpriceable',
				problem: 'the form must ask exactly one guestCount question'
			});
		});

		it('builds complete pricingInputs in every request it does build', () => {
			const variants: InquiryAnswers[] = [answered(), contactOnly(), emptyAnswers(form)];
			for (const picks of [[], ['vanilla'], ['chocolate', 'horchata'], ['mango']]) {
				for (const guests of ['', '1', '75']) {
					for (const minutes of ['', '90', '120']) {
						const answers = answered();
						answers.values.guestCount = guests;
						answers.values.durationMinutes = minutes;
						answers.values['offering:soft-serve-flavor'] = picks;
						variants.push(answers);
					}
				}
			}
			const built = variants.map((a) => prepareInquiry(form, a)).filter((c) => c.ok);
			expect(built.length).toBeGreaterThan(0);
			for (const command of built) {
				const { pricingInputs } = requestOf(command);
				expect(pricingInputs.catalogRevision).toBe(15);
				expect(pricingInputs.guestCount).toBeGreaterThanOrEqual(1);
				expect([90, 120]).toContain(pricingInputs.durationMinutes);
				expect(pricingInputs.selections[0]?.category).toBe('soft-serve-flavor');
				expect(pricingInputs.selections[0]?.offerings.length).toBeGreaterThanOrEqual(1);
			}
		});
	});

	it('refuses an unavailable pick on the current revision', () => {
		const answers = answered();
		answers.values['offering:soft-serve-flavor'] = ['vanilla', 'mango'];
		expect(prepareInquiry(form, answers)).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('pins older answers to their own revision and leaves option membership to the backend', () => {
		const answers = answered();
		answers.values['offering:soft-serve-flavor'] = ['vanilla', 'retired-since'];
		const request = requestOf(prepareInquiry(form, answers, { catalogRevision: 14 }));
		expect(request.pricingInputs.catalogRevision).toBe(14);
		expect(request.pricingInputs.selections[0]?.offerings).toEqual(['vanilla', 'retired-since']);

		// ...but never the service configuration itself.
		answers.values.guestCount = '';
		expect(prepareInquiry(form, answers, { catalogRevision: 14 }).ok).toBe(false);
	});
});

describe('pricingContractProblem', () => {
	it('accepts the version 7 form', () => {
		expect(pricingContractProblem(form)).toBeNull();
	});

	it('rejects an optional section carrying pricing questions', () => {
		const next = clone();
		next.sections[1]!.optional = true;
		expect(pricingContractProblem(next)).toBe(
			'section "service" has pricing questions but is marked optional'
		);
	});

	it('leaves optional sections without pricing questions alone', () => {
		const next = clone();
		next.sections[0]!.optional = true;
		expect(pricingContractProblem(next)).toBeNull();
	});

	it('names a missing duration question', () => {
		const next = clone();
		next.sections[1]!.fields = next.sections[1]!.fields.filter((f) => f.key !== 'durationMinutes');
		expect(pricingContractProblem(next)).toMatch(/durationMinutes/);
	});

	it('refuses a pricing pointer or input type it does not understand', () => {
		const unknown = clone();
		unknown.sections[1]!.fields[0]!.submissionPointer = '/pricingInputs/total';
		expect(pricingContractProblem(unknown)).toMatch(/unsupported pricing pointer/);

		const mismatched = clone();
		mismatched.sections[1]!.fields[0]!.input = { type: 'TEXT', minLength: 1, maxLength: 3 };
		expect(pricingContractProblem(mismatched)).toMatch(/unsupported input type/);
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
	/** The same form after a catalog publication: Horchata retired, at most one flavor. */
	function republished(): InquiryForm {
		const next = clone();
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
		expect(reconcileAnswers(form, answers)).toEqual({
			answers,
			changed: [],
			unavailable: [],
			removed: 0
		});
	});

	it('keeps contact details but drops a retired choice instead of substituting one', () => {
		const { answers, changed, removed, unavailable } = reconcileAnswers(republished(), answered());
		expect(answers.values.name).toBe('  Jane Doe ');
		expect(answers.values.email).toBe('jane@example.com');
		expect(answers.values.guestCount).toBe('75');
		expect(answers.values['offering:soft-serve-flavor']).toEqual(['vanilla']);
		expect(changed).toEqual(['offering:soft-serve-flavor']);
		// Gone from the menu: counted, never named or described (disabled and retired look alike).
		expect(removed).toBe(1);
		expect(unavailable).toEqual([]);
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
		const { answers, changed, unavailable, removed } = reconcileAnswers(next, previous);
		// Nothing substituted: the list is empty and the minimum now asks for a new choice.
		expect(answers.values['offering:soft-serve-flavor']).toEqual([]);
		expect(unavailable).toEqual(['Horchata']);
		expect(removed).toBe(0);
		expect(changed).toEqual(['offering:soft-serve-flavor']);
		expect(answers.values.guestCount).toBe('75');
		expect(validateAnswers(next, answers)['offering:soft-serve-flavor']).toMatch(/at least 1/);
	});

	it('never invents picks to meet a raised minimum', () => {
		const next = clone();
		next.catalogRevision = 16;
		const flavors = next.sections[1]!.fields.find((f) => f.key === 'offering:soft-serve-flavor')!;
		if (flavors.input.type === 'OFFERING_CHOICE') flavors.input.minSelections = 2;
		const previous = answered();
		previous.values['offering:soft-serve-flavor'] = ['vanilla'];

		const { answers, changed } = reconcileAnswers(next, previous);
		expect(answers.values['offering:soft-serve-flavor']).toEqual(['vanilla']);
		expect(changed).toEqual(['offering:soft-serve-flavor']);
		expect(prepareInquiry(next, answers)).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('flags a pick list over a lowered maximum without trimming it, and blocks sending it', () => {
		const answers = answered();
		answers.values['offering:soft-serve-flavor'] = ['vanilla', 'chocolate'];
		const result = reconcileAnswers(republished(), answers);
		expect(result.answers.values['offering:soft-serve-flavor']).toEqual(['vanilla', 'chocolate']);
		expect(result.changed).toEqual(['offering:soft-serve-flavor']);
		expect(validateAnswers(republished(), result.answers)['offering:soft-serve-flavor']).toMatch(
			/no more than 1/
		);
		expect(prepareInquiry(republished(), result.answers).ok).toBe(false);
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

	it('drafts pricing for the advisory estimate once the basics are known', () => {
		const answers = emptyAnswers(form);
		expect(draftPricingInputs(form, answers)).toBeNull();
		answers.values.guestCount = '20';
		answers.values.durationMinutes = '90';
		expect(draftPricingInputs(form, answers)).toEqual({
			catalogRevision: 15,
			guestCount: 20,
			guestCountIsMinimum: false,
			durationMinutes: 90,
			selections: []
		});
		// Not enough for the server preview, which needs the complete configuration.
		expect(completePricingInputs(form, answers)).toBeNull();
		expect(completePricingInputs(form, answered())?.selections).toHaveLength(1);
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
