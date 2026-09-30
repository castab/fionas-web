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

export type OfferingOption = {
	key: string;
	category: string;
	displayName: string;
	description?: string | null;
	price?: OfferingPrice;
};

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
	/** Added in definition version 2; absent from older backends, so the estimate degrades to server-only. */
	pricingPreview?: InquiryPricingPreview;
};

export type PricingSelection = { category: string; offerings: string[] };

export type PricingInputs = {
	catalogRevision: number;
	guestCount: number;
	guestCountIsMinimum?: boolean;
	durationMinutes: number;
	selections: PricingSelection[];
};

export type CreateInquiryRequest = {
	name: string;
	email: string;
	message?: string;
	pricingInputs?: PricingInputs;
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

function validateField(field: InquiryFormField, value: AnswerValue | undefined): string | null {
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
			const known = new Set(input.options.map((o) => o.key));
			if (picked.some((key) => !known.has(key)))
				return 'One of those options is no longer available.';
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

/** Per-field error messages for every field; empty when valid. */
export function validateAnswers(form: InquiryForm, answers: InquiryAnswers): FieldErrors {
	const errors: FieldErrors = {};
	for (const field of allFields(form)) {
		const error = validateField(field, answers.values[field.key]);
		if (error) errors[field.key] = error;
	}
	return errors;
}

// --- Request building -----------------------------------------------------------------------

const PRICING_POINTER = '/pricingInputs/';

function isPricingField(field: InquiryFormField): boolean {
	return field.submissionPointer.startsWith(PRICING_POINTER);
}

/** True when every pricing question has a valid answer, i.e. an estimate can be requested. */
export function isEstimateReady(form: InquiryForm, answers: InquiryAnswers): boolean {
	const fields = allFields(form).filter(isPricingField);
	return fields.length > 0 && fields.every((f) => validateField(f, answers.values[f.key]) === null);
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

/** `pricingInputs` for POST /estimate-preview and POST /inquiries, or undefined when unused. */
export function buildPricingInputs(
	form: InquiryForm,
	answers: InquiryAnswers
): PricingInputs | undefined {
	const fields = allFields(form).filter(isPricingField);
	if (fields.length === 0) return undefined;

	const pricing: Record<string, unknown> = { catalogRevision: form.catalogRevision };
	const selections: PricingSelection[] = [];
	for (const field of fields) {
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

/** The POST /inquiries body. Blank `message` is omitted; options/prices are never sent. */
export function buildInquiryRequest(
	form: InquiryForm,
	answers: InquiryAnswers
): CreateInquiryRequest {
	const request: Record<string, unknown> = {};
	for (const field of allFields(form)) {
		if (isPricingField(field)) continue;
		const value = answers.values[field.key];
		const text = typeof value === 'string' ? value.trim() : '';
		const property = field.submissionPointer.replace(/^\//, '');
		if (text !== '') request[property] = text;
	}
	const pricingInputs = buildPricingInputs(form, answers);
	if (pricingInputs) request.pricingInputs = pricingInputs;
	return request as CreateInquiryRequest;
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
	UNKNOWN_OFFERING:
		'One of your choices is no longer available. Reload the page to see the current options.',
	INVALID_GUEST_COUNT: "That guest count isn't something we can price. Try a different number.",
	UNSUPPORTED_DURATION: "We can't offer that service length. Pick one of the listed options."
};

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
