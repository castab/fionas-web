/*
 * Types and pure helpers for the API-driven inquiry (booking) form. The backend
 * (`fionas-commerce`) describes the questions via GET /inquiry-form; we render whatever it sends and
 * map the answers back with each field's `submissionPointer`. Validation here is UX only — the
 * server stays authoritative.
 */

// --- API shapes (mirror fionas-commerce-openapi.json) ---------------------------------------

export type OfferingPrice =
	| { kind: 'FIXED'; amount: string; currency: string }
	| { kind: 'PER_QUANTITY'; amount: string; currency: string; dimension: string }
	| { kind: 'PER_DURATION'; amount: string; currency: string; interval: string };

/**
 * One choice in an OFFERING_CHOICE question (commerce-runtime's `OfferingDto`). The public form only
 * lists ENABLED offerings: disabled and retired ones are absent. `availability` is independent: an
 * UNAVAILABLE option stays visible (name, description, price) but must not be selectable. It is
 * temporarily out, not removed from the menu.
 */
export type OfferingOption = {
	key: string;
	category: string;
	displayName: string;
	description?: string | null;
	/** Descriptive only; absent means the option adds no independent charge. */
	price?: OfferingPrice;
	selectionState: 'ENABLED' | 'DISABLED';
	availability: 'AVAILABLE' | 'UNAVAILABLE';
};

/** Whether a customer may pick this option right now (enabled and available). */
export const isSelectable = (option: OfferingOption): boolean =>
	option.selectionState === 'ENABLED' && option.availability === 'AVAILABLE';

export type InquiryInput =
	| { type: 'TEXT'; minLength: number; maxLength: number; pattern?: string }
	| { type: 'DATE'; format: string }
	| { type: 'STRING_CHOICE'; options: { value: string; label: string }[] }
	| { type: 'EMAIL'; maxLength: number }
	| { type: 'INTEGER'; minimum: number }
	| { type: 'BOOLEAN'; defaultValue: boolean }
	| { type: 'INTEGER_CHOICE'; options: { value: number; label: string }[] }
	| {
			type: 'OFFERING_CHOICE';
			category: string;
			minSelections: number;
			maxSelections?: number;
			options: OfferingOption[];
	  };

export type InquiryControl =
	'TEXT' | 'TEXTAREA' | 'NUMBER' | 'CHECKBOX' | 'SELECT' | 'CARDS' | 'CHECKBOXES' | 'DATE';

export type InquiryFormField = {
	key: string;
	label: string;
	description?: string;
	submissionPointer: string;
	required: boolean;
	input: InquiryInput;
	presentation: { control: InquiryControl };
};

export type InquiryFormSection = {
	key: string;
	title: string;
	description?: string;
	optional: boolean;
	fields: InquiryFormField[];
};

/** Pricing facts for one allowed service duration (from `pricingPreview` on GET /inquiry-form). */
export type DurationPricing = {
	durationMinutes: number;
	/** Exact decimal base-service amount at this duration; added once. */
	baseServiceAmount: string;
	/** Flat amounts for PER_DURATION offerings at this duration; add only the selected ones. */
	offeringContributions: { offeringKey: string; amount: string }[];
};

/** Facts for instant, advisory browser arithmetic. Never submitted; the server prices for real. */
export type InquiryPricingPreview = {
	currency: string;
	/** PER_QUANTITY options use this dimension; its quantity is the guest count. */
	guestQuantityDimension: string;
	durationOptions: DurationPricing[];
	/** Exact decimal ice cream service amount per guest. */
	perGuestAmount: string;
	toppingAdjustment: {
		category: string;
		includedSelections: number;
		additionalSelectionPerGuestAmount: string;
	};
};

export type InquiryForm = {
	definitionVersion: number;
	catalogId: string;
	catalogRevision: number;
	sections: InquiryFormSection[];
	/** Facts for the instant advisory estimate, for exactly this `catalogRevision`. */
	pricingPreview: InquiryPricingPreview;
};

/**
 * The question-definition version this UI was built against (GET /inquiry-form). From version 7 the
 * service section is required: every inquiry is a request for configured ice cream service.
 */
export const EXPECTED_DEFINITION_VERSION = 7;

export type PricingSelection = { category: string; offerings: string[] };

export type PricingInputs = {
	catalogRevision: number;
	guestCount: number;
	guestCountIsMinimum: boolean;
	durationMinutes: number;
	selections: PricingSelection[];
};

/**
 * POST /inquiries: customer intent only, never amounts. `pricingInputs` is required: there is no
 * plain/contact-only inquiry, because the backend prices every accepted inquiry into Estimate v1.
 * Build one only through `prepareInquiry`, which refuses incomplete service configuration.
 */
export type CreateInquiryRequest = {
	name: string;
	email: string;
	message?: string;
	zipCode: string;
	eventDate: string;
	eventType: string;
	pricingInputs: PricingInputs;
};

export type EstimateLine = {
	description: string;
	subDescription?: string;
	quantity?: string;
	unitPrice: string;
	subtotal: string;
	taxAmount: string;
	total: string;
	currency: string;
};

export type EstimatePreview = {
	catalogRevision: number;
	guestCountIsMinimum: boolean;
	lines: EstimateLine[];
	subtotal: string;
	taxAmount: string;
	total: string;
	currency: string;
};

// --- Answers --------------------------------------------------------------------------------

/** Raw answer per field key: text/number/select as string, checkbox as boolean, offerings as keys. */
export type AnswerValue = string | boolean | string[];

export type InquiryAnswers = {
	values: Record<string, AnswerValue>;
};

export function emptyAnswers(form: InquiryForm): InquiryAnswers {
	const values: Record<string, AnswerValue> = {};
	for (const section of form.sections) {
		for (const field of section.fields) {
			values[field.key] =
				field.input.type === 'BOOLEAN' ? field.input.defaultValue : initial(field);
		}
	}
	return { values };
}

function initial(field: InquiryFormField): AnswerValue {
	return field.input.type === 'OFFERING_CHOICE' ? [] : '';
}

/** Anything exposing the `FormData` read API (keeps this package free of DOM typings). */
export type FormDataLike = {
	get(name: string): unknown;
	getAll(name: string): unknown[];
};

/** Reads answers back out of a submitted form (field `name` = field key). */
export function answersFromFormData(form: InquiryForm, data: FormDataLike): InquiryAnswers {
	const answers = emptyAnswers(form);
	for (const section of form.sections) {
		for (const field of section.fields) {
			if (field.input.type === 'BOOLEAN') {
				answers.values[field.key] = data.get(field.key) !== null;
			} else if (field.input.type === 'OFFERING_CHOICE') {
				answers.values[field.key] = data.getAll(field.key).filter((v) => typeof v === 'string');
			} else {
				const raw = data.get(field.key);
				answers.values[field.key] = typeof raw === 'string' ? raw : '';
			}
		}
	}
	return answers;
}

// --- Validation -----------------------------------------------------------------------------

const INT32_MAX = 2_147_483_647;
const EMAIL_SHAPE = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/;

export type FieldErrors = Record<string, string>;

/** The API's text patterns are simple anchored regexes; an unusable pattern never blocks input. */
function matchesPattern(pattern: string, text: string): boolean {
	try {
		return new RegExp(pattern).test(text);
	} catch {
		return true;
	}
}

/** True for patterns like ^[0-9]{5}$, which are worth a numeric keyboard and a plainer message. */
export function isDigitsOnly(pattern: string): boolean {
	return /^\^?\[0-9\](\{\d+\}|\+|\*)?\$?$/.test(pattern);
}

/** YYYY-MM-DD naming a real calendar day (so 2026-02-30 is rejected). */
function isCalendarDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return false;
	const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
	if (year < 1) return false;
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
	);
}

function allFields(form: InquiryForm): InquiryFormField[] {
	return form.sections.flatMap((s) => s.fields);
}

type ValidateOptions = {
	/**
	 * Check offering picks against the options this form lists (known, selectable). Off only when
	 * answers given on an older catalog revision are checked against the current form: the backend
	 * then decides (replaying an earlier commit of the key, or refusing the revision as stale).
	 * Every other rule (required answers, guest count, duration, selection counts) always applies.
	 */
	catalog?: boolean;
};

function validateField(
	field: InquiryFormField,
	value: AnswerValue | undefined,
	{ catalog = true }: ValidateOptions = {}
): string | null {
	const input = field.input;
	switch (input.type) {
		case 'TEXT': {
			const text = typeof value === 'string' ? value.trim() : '';
			if (text.length === 0) return field.required ? 'This field is required.' : null;
			// The pattern comes first: "Enter 5 digits." beats "Use at least 5 characters." for a ZIP.
			if (input.pattern && !matchesPattern(input.pattern, text)) {
				return isDigitsOnly(input.pattern) && input.minLength === input.maxLength
					? `Enter ${input.maxLength} digits.`
					: 'Check the format of this answer.';
			}
			if (text.length < input.minLength) return `Use at least ${input.minLength} characters.`;
			if (text.length > input.maxLength) return `Keep this under ${input.maxLength} characters.`;
			return null;
		}
		case 'DATE': {
			const date = typeof value === 'string' ? value.trim() : '';
			if (date.length === 0) return field.required ? 'Pick a date.' : null;
			return isCalendarDate(date) ? null : 'Enter a valid date.';
		}
		case 'STRING_CHOICE': {
			const raw = typeof value === 'string' ? value : '';
			if (raw === '') return field.required ? 'Choose an option.' : null;
			return input.options.some((o) => o.value === raw) ? null : 'Choose an option.';
		}
		case 'EMAIL': {
			const email = typeof value === 'string' ? value.trim() : '';
			if (email.length === 0) return field.required ? 'This field is required.' : null;
			if (email.length > input.maxLength) return `Keep this under ${input.maxLength} characters.`;
			return EMAIL_SHAPE.test(email) ? null : 'Enter an email address like name@example.com.';
		}
		case 'INTEGER': {
			const raw = typeof value === 'string' ? value.trim() : '';
			if (raw.length === 0) return field.required ? 'This field is required.' : null;
			const n = Number(raw);
			if (!Number.isInteger(n) || n > INT32_MAX) return 'Enter a whole number.';
			if (n < input.minimum) return `Enter ${input.minimum} or more.`;
			return null;
		}
		case 'INTEGER_CHOICE': {
			const raw = typeof value === 'string' ? value : '';
			if (raw === '') return field.required ? 'Choose an option.' : null;
			return input.options.some((o) => String(o.value) === raw) ? null : 'Choose an option.';
		}
		case 'BOOLEAN':
			return null;
		case 'OFFERING_CHOICE': {
			const picked = Array.isArray(value) ? value : [];
			if (catalog) {
				const options = new Map(input.options.map((o) => [o.key, o]));
				if (picked.some((key) => !options.has(key)))
					return 'One of those options is no longer offered.';
				const unavailable = picked.map((key) => options.get(key)!).find((o) => !isSelectable(o));
				if (unavailable) {
					return `${unavailable.displayName} is unavailable right now — please choose another.`;
				}
			}
			if (new Set(picked).size !== picked.length) return 'Choose each option only once.';
			if (picked.length < input.minSelections) {
				return input.maxSelections === input.minSelections
					? `Choose ${input.minSelections}.`
					: `Choose at least ${input.minSelections}.`;
			}
			if (input.maxSelections !== undefined && picked.length > input.maxSelections) {
				return `Choose no more than ${input.maxSelections}.`;
			}
			return null;
		}
	}
}

function hasAnswer(field: InquiryFormField, value: AnswerValue | undefined): boolean {
	if (Array.isArray(value)) return value.length > 0;
	return typeof value === 'string' && value.trim() !== '';
}

const PRICING_POINTER = '/pricingInputs/';

/** A question whose answer belongs in `pricingInputs` (guest count, duration, offering picks). */
export function isPricingField(field: InquiryFormField): boolean {
	return field.submissionPointer.startsWith(PRICING_POINTER);
}

/**
 * Whether a whole section may be left blank: exactly the backend's `optional` flag (field
 * requirements apply once it is used). In definition version 7 only "Additional information" is
 * optional. A form marking a pricing section optional is not reinterpreted here: it contradicts
 * POST /inquiries (`pricingInputs` is required), so `pricingContractProblem` rejects it outright.
 */
export function isSkippable(section: InquiryFormSection): boolean {
	return section.optional;
}

/**
 * Whether the customer has started answering a section. A checkbox alone (it always has a value)
 * doesn't count as starting.
 */
function isSectionInUse(section: InquiryFormSection, answers: InquiryAnswers): boolean {
	return section.fields.some(
		(field) => field.input.type !== 'BOOLEAN' && hasAnswer(field, answers.values[field.key])
	);
}

/** The questions that apply: every non-skippable section, plus skippable ones the customer started. */
function activeFields(form: InquiryForm, answers: InquiryAnswers): InquiryFormField[] {
	return form.sections
		.filter((section) => !isSkippable(section) || isSectionInUse(section, answers))
		.flatMap((section) => section.fields);
}

/** Per-field error messages for every question that applies; empty when valid. */
export function validateAnswers(
	form: InquiryForm,
	answers: InquiryAnswers,
	options: ValidateOptions = {}
): FieldErrors {
	const errors: FieldErrors = {};
	for (const field of activeFields(form, answers)) {
		const error = validateField(field, answers.values[field.key], options);
		if (error) errors[field.key] = error;
	}
	return errors;
}

// --- Catalog refresh ------------------------------------------------------------------------

/**
 * Fits answers given on an older form to a refreshed one (after `CATALOG_REVISION_STALE`) without
 * guessing. Contact and event answers carry over. A choice the new form no longer offers (disabled
 * or retired: absent) or can't take right now (UNAVAILABLE: still listed) is unselected, never
 * swapped for another. A pick list that no longer fits changed limits is never padded to a new
 * minimum and never trimmed to a new maximum: the customer sees the limit and decides (checked
 * choices stay uncheckable). `changed` lists the keys of every question the customer must look at
 * again; `unavailable` names the picks unselected because they are temporarily unavailable;
 * `removed` counts picks the menu no longer lists (disabled or retired, which the public form can't
 * tell apart and must not describe further).
 */
export function reconcileAnswers(
	form: InquiryForm,
	previous: InquiryAnswers
): { answers: InquiryAnswers; changed: string[]; unavailable: string[]; removed: number } {
	const answers = emptyAnswers(form);
	const changed: string[] = [];
	const unavailable: string[] = [];
	let removed = 0;
	for (const field of allFields(form)) {
		const value = previous.values[field.key];
		const input = field.input;
		switch (input.type) {
			case 'OFFERING_CHOICE': {
				const picked = Array.isArray(value) ? value : [];
				const options = new Map(input.options.map((o) => [o.key, o]));
				const kept = picked.filter((key) => {
					const option = options.get(key);
					if (!option) removed += 1;
					else if (!isSelectable(option)) unavailable.push(option.displayName);
					return option !== undefined && isSelectable(option);
				});
				answers.values[field.key] = kept;
				if (kept.length !== picked.length || (kept.length > 0 && validateField(field, kept))) {
					changed.push(field.key);
				}
				break;
			}
			case 'STRING_CHOICE':
			case 'INTEGER_CHOICE': {
				const raw = typeof value === 'string' ? value : '';
				const offered = input.options.some((o) => String(o.value) === raw);
				answers.values[field.key] = offered ? raw : '';
				if (raw !== '' && !offered) changed.push(field.key);
				break;
			}
			case 'BOOLEAN':
				if (typeof value === 'boolean') answers.values[field.key] = value;
				break;
			default:
				if (typeof value === 'string') answers.values[field.key] = value;
		}
	}
	return { answers, changed, unavailable, removed };
}

// --- Request building -----------------------------------------------------------------------

/** `pricingInputs` properties that a form question may point at, by the input types that fit. */
const PRICING_PROPERTIES: Record<string, InquiryInput['type'][]> = {
	guestCount: ['INTEGER', 'INTEGER_CHOICE'],
	guestCountIsMinimum: ['BOOLEAN'],
	durationMinutes: ['INTEGER', 'INTEGER_CHOICE'],
	selections: ['OFFERING_CHOICE']
};

/** `pricingInputs` properties the request cannot do without; the form must ask for each. */
const REQUIRED_PRICING = ['guestCount', 'durationMinutes'] as const;

/**
 * Why this form definition is incompatible with POST /inquiries, or null when it isn't: a pricing
 * section marked optional, no guest count or duration question, or a pricing pointer this UI doesn't
 * understand. Such a form can't reliably produce an inquiry, so the page must not offer it: the
 * caller fails closed.
 */
export function pricingContractProblem(form: InquiryForm): string | null {
	// An inquiry is configured service: a definition that lets the customer omit it is incompatible
	// with this UI, not something to quietly make required.
	const optional = form.sections.find((s) => s.optional && s.fields.some(isPricingField));
	if (optional) return `section "${optional.key}" has pricing questions but is marked optional`;
	const pricing = allFields(form).filter(isPricingField);
	for (const field of pricing) {
		const property = field.submissionPointer.slice(PRICING_POINTER.length);
		const types = PRICING_PROPERTIES[property];
		if (!types) return `unsupported pricing pointer ${field.submissionPointer}`;
		if (!types.includes(field.input.type)) {
			return `${field.submissionPointer} has an unsupported input type ${field.input.type}`;
		}
	}
	for (const property of REQUIRED_PRICING) {
		const asked = pricing.filter((f) => f.submissionPointer === `${PRICING_POINTER}${property}`);
		if (asked.length !== 1) return `the form must ask exactly one ${property} question`;
		if (!asked[0]!.required) return `the ${property} question must be required`;
	}
	return null;
}

/** True when every pricing question has a valid answer, i.e. an estimate can be requested. */
export function isEstimateReady(form: InquiryForm, answers: InquiryAnswers): boolean {
	const fields = allFields(form).filter(isPricingField);
	return fields.length > 0 && fields.every((f) => validateField(f, answers.values[f.key]) === null);
}

/**
 * Reads the pricing answers into `pricingInputs` by submission pointer, without judging them. Picks
 * go in form order, one block per category that has any (a category whose minimum is 0 may be left
 * empty). `guestCountIsMinimum` is false unless a question sets it, as the backend defaults it.
 */
function collectPricing(
	form: InquiryForm,
	answers: InquiryAnswers,
	catalogRevision: number
): PricingInputs {
	const pricing: Record<string, unknown> = { catalogRevision, guestCountIsMinimum: false };
	const selections: PricingSelection[] = [];
	for (const field of allFields(form).filter(isPricingField)) {
		const value = answers.values[field.key];
		const property = field.submissionPointer.slice(PRICING_POINTER.length);
		switch (field.input.type) {
			case 'OFFERING_CHOICE': {
				const offerings = Array.isArray(value) ? value : [];
				if (offerings.length > 0) selections.push({ category: field.input.category, offerings });
				break;
			}
			case 'INTEGER':
			case 'INTEGER_CHOICE':
				if (typeof value === 'string' && value.trim() !== '') pricing[property] = Number(value);
				break;
			case 'BOOLEAN':
				pricing[property] = value === true;
				break;
		}
	}
	pricing.selections = selections;
	return pricing as PricingInputs;
}

const isCount = (n: unknown, minimum: number) =>
	typeof n === 'number' && Number.isInteger(n) && n >= minimum && n <= INT32_MAX;

/**
 * The transport-level floor under every inquiry: a revision, a guest count, a duration and a
 * selection block meeting every category's minimum. Checked again after validation so that no
 * future change to validation can let a contact-only or partial request through.
 */
function isCompletePricing(form: InquiryForm, pricing: PricingInputs): boolean {
	if (!isCount(pricing.catalogRevision, 1) || !isCount(pricing.guestCount, 1)) return false;
	if (!isCount(pricing.durationMinutes, 1) || typeof pricing.guestCountIsMinimum !== 'boolean') {
		return false;
	}
	return allFields(form).every((field) => {
		if (field.input.type !== 'OFFERING_CHOICE' || field.input.minSelections === 0) return true;
		const { category, minSelections } = field.input;
		const block = pricing.selections.find((s) => s.category === category);
		return block !== undefined && block.offerings.length >= minSelections;
	});
}

/**
 * True once the answers that set the base price (guest count, service length) are valid. That is
 * enough for an instant "estimate so far" even before every offering has been chosen.
 */
export function hasPricingBasics(form: InquiryForm, answers: InquiryAnswers): boolean {
	const fields = allFields(form).filter(
		(f) => isPricingField(f) && (f.input.type === 'INTEGER' || f.input.type === 'INTEGER_CHOICE')
	);
	return fields.length > 0 && fields.every((f) => validateField(f, answers.values[f.key]) === null);
}

/**
 * The service configured so far, for the advisory "estimate so far": null until guest count and
 * service length are valid. Presentation only, never submitted.
 */
export function draftPricingInputs(
	form: InquiryForm,
	answers: InquiryAnswers
): PricingInputs | null {
	if (!hasPricingBasics(form, answers)) return null;
	return collectPricing(form, answers, form.catalogRevision);
}

/**
 * Complete `pricingInputs` for POST /estimate-preview: null until every pricing question has a
 * valid answer.
 */
export function completePricingInputs(
	form: InquiryForm,
	answers: InquiryAnswers
): PricingInputs | null {
	if (pricingContractProblem(form) !== null || !isEstimateReady(form, answers)) return null;
	const pricing = collectPricing(form, answers, form.catalogRevision);
	return isCompletePricing(form, pricing) ? pricing : null;
}

/**
 * One logical inquiry command, or why there is none. `invalid`: the answers fail the form's own
 * rules (including unconfigured service). `unpriceable`: the form definition itself can't produce
 * `pricingInputs`; no answers can fix that, so nothing may be sent.
 */
export type InquiryCommand =
	| { ok: true; request: CreateInquiryRequest }
	| { ok: false; reason: 'invalid'; errors: FieldErrors }
	| { ok: false; reason: 'unpriceable'; problem: string };

/**
 * The submit gate and the only way to build a POST /inquiries body. Validates every question that
 * applies (the service section always applies), then maps answers to the request by submission
 * pointer, pinned to `catalogRevision`: the revision the customer answered on, which is the form's
 * own unless the caller is checking older answers against a newer form (then option membership is
 * left to the backend; see `ValidateOptions`). The body is customer intent only: complete
 * `pricingInputs`, no prices, totals, lines or estimate identity. A blank `message` is omitted.
 */
export function prepareInquiry(
	form: InquiryForm,
	answers: InquiryAnswers,
	{ catalogRevision = form.catalogRevision }: { catalogRevision?: number } = {}
): InquiryCommand {
	const problem = pricingContractProblem(form);
	if (problem) return { ok: false, reason: 'unpriceable', problem };

	const catalog = catalogRevision === form.catalogRevision;
	const errors = validateAnswers(form, answers, { catalog });
	if (Object.keys(errors).length > 0) return { ok: false, reason: 'invalid', errors };

	const pricingInputs = collectPricing(form, answers, catalogRevision);
	if (!isCompletePricing(form, pricingInputs)) {
		return { ok: false, reason: 'unpriceable', problem: 'incomplete pricingInputs' };
	}

	const request: Record<string, unknown> = {};
	for (const field of activeFields(form, answers)) {
		if (isPricingField(field)) continue;
		const value = answers.values[field.key];
		const text = typeof value === 'string' ? value.trim() : '';
		const property = field.submissionPointer.replace(/^\//, '');
		if (text !== '') request[property] = text;
	}
	request.pricingInputs = pricingInputs;
	return { ok: true, request: request as CreateInquiryRequest };
}

// --- Errors ---------------------------------------------------------------------------------

export type ApiError = {
	status: number;
	code: string;
	message: string;
	violations: string[];
};

const violationCopy: Record<string, string> = {
	TOO_MANY_SELECTIONS: 'You picked too many options in one of the lists.',
	TOO_FEW_SELECTIONS: "You haven't picked enough options in one of the lists.",
	UNKNOWN_OFFERING: 'One of your choices is no longer on our menu. Please choose again.',
	OFFERING_DISABLED: 'One of your choices is no longer on our menu. Please choose again.',
	OFFERING_UNAVAILABLE:
		'One of your choices is unavailable right now. Please choose another, or check back later.',
	INVALID_GUEST_COUNT: "That guest count isn't something we can price. Try a different number.",
	UNSUPPORTED_DURATION: "We can't offer that service length. Pick one of the listed options.",
	PUBLIC_INQUIRY_CATEGORY_NOT_ALLOWED:
		"One of your choices can't be requested online. Please choose again."
};

/**
 * Violations meaning the page's options no longer match the catalog (the form is out of date or was
 * tampered with). The right recovery is a fresh form for the customer to review, never a resubmit.
 */
export const CATALOG_STATE_VIOLATIONS: ReadonlySet<string> = new Set([
	'UNKNOWN_OFFERING',
	'OFFERING_DISABLED',
	'OFFERING_UNAVAILABLE',
	'PUBLIC_INQUIRY_CATEGORY_NOT_ALLOWED'
]);

/** Friendly copy for a stable violation code; never surfaces the server's diagnostic message. */
export function describeViolation(code: string): string {
	return violationCopy[code] ?? "Some of your answers couldn't be accepted. Please review them.";
}

// --- Formatting -----------------------------------------------------------------------------

export function formatMoney(amount: string, currency: string): string {
	const n = Number(amount);
	if (!Number.isFinite(n)) return amount;
	// Whole-dollar amounts read cleaner without cents: $225, but $643.75.
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency,
		minimumFractionDigits: Number.isInteger(n) ? 0 : 2
	}).format(n);
}

function formatInterval(interval: string): string {
	const hours = /^PT(\d+)H$/.exec(interval);
	if (hours) return hours[1] === '1' ? 'hour' : `${hours[1]} hours`;
	const minutes = /^PT(\d+)M$/.exec(interval);
	if (minutes) return `${minutes[1]} min`;
	return 'event';
}

/** "+$0.50/guest" style label for an offering's descriptive price. */
export function formatOfferingPrice(price: OfferingPrice): string {
	const money = formatMoney(price.amount, price.currency);
	switch (price.kind) {
		case 'FIXED':
			return `+${money}`;
		case 'PER_QUANTITY':
			return `+${money}/${price.dimension}`;
		case 'PER_DURATION':
			return `+${money}/${formatInterval(price.interval)}`;
	}
}
