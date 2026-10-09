import { describe, expect, it } from 'vitest';
import {
	answersFromFormData,
	completeServiceInputs,
	draftServiceInputs,
	emptyAnswers,
	formatOfferingPrice,
	hasPricingBasics,
	INQUIRY_EVENT_TYPES,
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
	priceRevision: '15',
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
				},
				{
					key: 'zipCode',
					label: 'ZIP code',
					submissionPointer: '/zipCode',
					required: true,
					input: { type: 'TEXT', minLength: 5, maxLength: 5, pattern: '^[0-9]{5}$' },
					presentation: { control: 'TEXT' }
				},
				{
					key: 'eventDate',
					label: 'Event date',
					submissionPointer: '/eventDate',
					required: true,
					input: { type: 'DATE', format: 'date' },
					presentation: { control: 'DATE' }
				},
				{
					key: 'eventType',
					label: 'Event type',
					submissionPointer: '/eventType',
					required: true,
					input: {
						type: 'STRING_CHOICE',
						options: [
							{ value: 'BIRTHDAY', label: 'Birthday' },
							{ value: 'SCHOOL_EVENT', label: 'School event' }
						]
					},
					presentation: { control: 'SELECT' }
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
					submissionPointer: '/serviceInputs/guestCount',
					required: true,
					input: { type: 'INTEGER', minimum: 1 },
					presentation: { control: 'NUMBER' }
				},
				{
					key: 'guestCountIsMinimum',
					label: 'This is a minimum guest count',
					submissionPointer: '/serviceInputs/guestCountIsMinimum',
					required: false,
					input: { type: 'BOOLEAN', defaultValue: false },
					presentation: { control: 'CHECKBOX' }
				},
				{
					key: 'offering:soft-serve-flavor',
					label: 'Choose your soft serve flavors',
					submissionPointer: '/serviceInputs/selections',
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
		baseServiceAmount: '0.00',
		perGuestAmount: '1.00',
		toppingAdjustment: {
			category: 'topping',
			includedSelections: 0,
			additionalSelectionPerGuestAmount: '0.00'
		}
	}
};

const clone = (f: InquiryForm = form) => JSON.parse(JSON.stringify(f)) as InquiryForm;

/** Contact and event details, as every inquiry carries them. */
function withDetails(answers: InquiryAnswers) {
	answers.values.zipCode = '02134';
	answers.values.eventDate = '2026-12-05';
	answers.values.eventType = 'BIRTHDAY';
	return answers;
}

function answered() {
	const answers = withDetails(emptyAnswers(form));
	answers.values.name = '  Jane Doe ';
	answers.values.email = 'jane@example.com';
	answers.values.guestCount = '75';
	answers.values['offering:soft-serve-flavor'] = ['vanilla', 'horchata'];
	return answers;
}

/** The answers of a customer who filled in contact details and a message, but no service. */
function contactOnly(): InquiryAnswers {
	const answers = withDetails(emptyAnswers(form));
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
			'email',
			'eventDate',
			'eventType',
			'guestCount',
			'name',
			'offering:soft-serve-flavor',
			'zipCode'
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
			zipCode: '02134',
			eventDate: '2026-12-05',
			eventType: 'BIRTHDAY',
			serviceInputs: {
				priceRevision: '15',
				guestCount: 75,
				guestCountIsMinimum: false,
				selections: [{ category: 'soft-serve-flavor', offerings: ['vanilla', 'horchata'] }]
			}
		});
	});

	it('sends guestCountIsMinimum from its question, false when the form asks none', () => {
		const answers = answered();
		answers.values.guestCountIsMinimum = true;
		expect(requestOf(prepareInquiry(form, answers)).serviceInputs.guestCountIsMinimum).toBe(true);

		const withoutQuestion = clone();
		withoutQuestion.sections[1]!.fields = withoutQuestion.sections[1]!.fields.filter(
			(f) => f.key !== 'guestCountIsMinimum'
		);
		const request = requestOf(prepareInquiry(withoutQuestion, answered()));
		expect(request.serviceInputs.guestCountIsMinimum).toBe(false);
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
		expect(text).not.toMatch(/amount|total|unitPrice|lines|estimate|label|displayName|options/i);
	});

	// Critical regression: there is no plain/contact-only inquiry any more (definition version 7).
	describe('no inquiry without configured ice cream service', () => {
		it('refuses contact details and a message alone', () => {
			expect(prepareInquiry(form, contactOnly())).toEqual({
				ok: false,
				reason: 'invalid',
				errors: {
					guestCount: 'This field is required.',
					'offering:soft-serve-flavor': 'Choose at least 1.'
				}
			});
		});

		it('rejects a definition that marks the service section optional, whatever the answers', () => {
			const drifted = clone();
			drifted.sections[1]!.optional = true;
			const rejected = {
				ok: false,
				reason: 'incompatible',
				problem: 'section "service" has pricing questions but is marked optional'
			};
			// Not coerced into a required section: even complete answers produce no request.
			expect(prepareInquiry(drifted, contactOnly())).toEqual(rejected);
			expect(prepareInquiry(drifted, answered())).toEqual(rejected);
		});

		it.each([
			['guest count', { guestCount: '' }],
			['required offering picks', { 'offering:soft-serve-flavor': [] }],
			['a whole-number guest count', { guestCount: '12.5' }],
			['a plain-digit guest count', { guestCount: '1e2' }]
		])('refuses a request missing %s', (_, change) => {
			const answers = answered();
			Object.assign(answers.values, change);
			expect(prepareInquiry(form, answers).ok).toBe(false);
		});

		it('refuses a form that cannot produce serviceInputs, whatever the answers', () => {
			const noService = clone();
			noService.sections = noService.sections.filter((s) => s.key !== 'service');
			expect(prepareInquiry(noService, contactOnly())).toEqual({
				ok: false,
				reason: 'incompatible',
				problem: 'the form must ask exactly one guestCount question'
			});
		});

		it('refuses a form that never asks for a field POST /inquiries requires', () => {
			const noZip = clone();
			noZip.sections[0]!.fields = noZip.sections[0]!.fields.filter((f) => f.key !== 'zipCode');
			expect(prepareInquiry(noZip, answered())).toEqual({
				ok: false,
				reason: 'incompatible',
				problem: 'the form gave no zipCode'
			});
		});

		it('builds complete serviceInputs in every request it does build', () => {
			const variants: InquiryAnswers[] = [answered(), contactOnly(), emptyAnswers(form)];
			for (const picks of [[], ['vanilla'], ['chocolate', 'horchata'], ['mango']]) {
				for (const guests of ['', '1', '75']) {
					const answers = answered();
					answers.values.guestCount = guests;
					answers.values['offering:soft-serve-flavor'] = picks;
					variants.push(answers);
				}
			}
			const built = variants.map((a) => prepareInquiry(form, a)).filter((c) => c.ok);
			expect(built.length).toBeGreaterThan(0);
			for (const command of built) {
				const { serviceInputs } = requestOf(command);
				expect(serviceInputs.priceRevision).toBe('15');
				expect(serviceInputs.guestCount).toBeGreaterThanOrEqual(1);
				expect(serviceInputs).not.toHaveProperty('durationMinutes');
				expect(serviceInputs.selections[0]?.category).toBe('soft-serve-flavor');
				expect(serviceInputs.selections[0]?.offerings.length).toBeGreaterThanOrEqual(1);
			}
		});
	});

	it('sends each of the backend event types as offered', () => {
		const every = clone();
		const eventType = every.sections[0]!.fields.find((f) => f.key === 'eventType')!;
		eventType.input = {
			type: 'STRING_CHOICE',
			options: INQUIRY_EVENT_TYPES.map((value) => ({ value, label: value }))
		};
		for (const type of INQUIRY_EVENT_TYPES) {
			const answers = answered();
			answers.values.eventType = type;
			expect(requestOf(prepareInquiry(every, answers)).eventType).toBe(type);
		}
	});

	it('refuses an event type the backend does not know, even if a form offers it', () => {
		const drifted = clone();
		const eventType = drifted.sections[0]!.fields.find((f) => f.key === 'eventType')!;
		eventType.input = { type: 'STRING_CHOICE', options: [{ value: 'PARADE', label: 'Parade' }] };
		const answers = answered();
		answers.values.eventType = 'PARADE';
		expect(prepareInquiry(drifted, answers)).toEqual({
			ok: false,
			reason: 'incompatible',
			problem: 'the form gave no known eventType'
		});
	});

	it('refuses an unavailable pick on the current revision', () => {
		const answers = answered();
		answers.values['offering:soft-serve-flavor'] = ['vanilla', 'mango'];
		expect(prepareInquiry(form, answers)).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('validates menu membership even when a caller supplies an old freshness token', () => {
		const answers = answered();
		answers.values['offering:soft-serve-flavor'] = ['retired-since'];
		expect(prepareInquiry(form, answers, { priceRevision: 'old' }).ok).toBe(false);
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

	it('has no service duration: a duration question is an unsupported pointer', () => {
		const next = clone();
		next.sections[1]!.fields.push({
			key: 'durationMinutes',
			label: 'Duration',
			submissionPointer: '/serviceInputs/durationMinutes',
			required: true,
			input: { type: 'INTEGER_CHOICE', options: [{ value: 90, label: '90 minutes' }] },
			presentation: { control: 'CHIPS' }
		});
		expect(pricingContractProblem(next)).toMatch(/unsupported pricing pointer/);
	});

	it('refuses a pricing pointer or input type it does not understand', () => {
		const unknown = clone();
		unknown.sections[1]!.fields[0]!.submissionPointer = '/serviceInputs/total';
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
		next.priceRevision = '16';
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
		next.priceRevision = '16';
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
		const type = next.sections.flatMap((s) => s.fields).find((f) => f.key === 'eventType')!;
		if (type.input.type === 'STRING_CHOICE')
			type.input.options = type.input.options.filter((o) => o.value !== 'BIRTHDAY');
		const { answers, changed } = reconcileAnswers(next, answered());
		expect(answers.values.eventType).toBe('');
		expect(changed).toContain('eventType');
	});
});

describe('estimates', () => {
	it('is ready only when every pricing question is valid', () => {
		const answers = answered();
		expect(isEstimateReady(form, answers)).toBe(true);
		answers.values['offering:soft-serve-flavor'] = [];
		expect(isEstimateReady(form, answers)).toBe(false);
		// ...but the guest count is enough for an "estimate so far".
		expect(hasPricingBasics(form, answers)).toBe(true);
		answers.values.guestCount = '';
		expect(hasPricingBasics(form, answers)).toBe(false);
	});

	it('drafts pricing for the advisory estimate once the basics are known', () => {
		const answers = emptyAnswers(form);
		expect(draftServiceInputs(form, answers)).toBeNull();
		answers.values.guestCount = '20';
		expect(draftServiceInputs(form, answers)).toEqual({
			priceRevision: '15',
			guestCount: 20,
			guestCountIsMinimum: false,
			selections: []
		});
		// Not enough for the server preview, which needs the complete configuration.
		expect(completeServiceInputs(form, answers)).toBeNull();
		expect(completeServiceInputs(form, answered())?.selections).toHaveLength(1);
	});
});

describe('answersFromFormData', () => {
	it('reads text, checkbox and multi-value fields', () => {
		const entries: [string, string][] = [
			['name', 'Jane'],
			['email', 'jane@example.com'],
			['zipCode', '02134'],
			['eventDate', '2026-12-05'],
			['eventType', 'SCHOOL_EVENT'],
			['guestCount', '50'],
			['guestCountIsMinimum', 'on'],
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
	});
});

describe('bounded guest count', () => {
	const bounded = () => {
		const next = clone();
		const guests = next.sections[1]!.fields.find((f) => f.key === 'guestCount')!;
		guests.input = { type: 'INTEGER', minimum: 1, maximum: 300, defaultValue: 50 };
		guests.presentation = {
			control: 'STEPPER',
			messages: {
				belowMinimum: 'Add a rough headcount.',
				aboveMaximum: 'We quote up to 300 online.'
			}
		};
		return next;
	};

	it('starts at the code-owned default', () => {
		expect(emptyAnswers(bounded()).values.guestCount).toBe('50');
	});

	it('rejects counts above the maximum with the code-owned message, and accepts the maximum', () => {
		const answers = answered();
		answers.values.guestCount = '301';
		expect(validateAnswers(bounded(), answers).guestCount).toBe('We quote up to 300 online.');
		expect(prepareInquiry(bounded(), answers).ok).toBe(false);
		answers.values.guestCount = '300';
		expect(requestOf(prepareInquiry(bounded(), answers)).serviceInputs.guestCount).toBe(300);
	});

	it('asks for a headcount below the minimum or when blank', () => {
		const answers = answered();
		for (const guests of ['0', '']) {
			answers.values.guestCount = guests;
			expect(validateAnswers(bounded(), answers).guestCount).toBe('Add a rough headcount.');
		}
	});
});
