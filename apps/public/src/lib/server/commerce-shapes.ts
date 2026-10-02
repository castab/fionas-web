import {
	INQUIRY_EVENT_TYPES,
	type CreateInquiryRequest,
	type EstimatePreview,
	type InquiryEventType,
	type InquiryForm
} from '@fionas/shared';

/*
 * Structural checks at the server's edges, so it fails closed: a 2xx from fionas-commerce whose body
 * isn't the documented shape is treated as an unexpected response, never rendered or trusted, and a
 * replayed inquiry from the browser is sent only in the exact request shape. These check structure
 * only (types, enums, exact decimals); meaning stays with the backend.
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown, min = Number.MIN_SAFE_INTEGER): v is number =>
	typeof v === 'number' && Number.isInteger(v) && v >= min;
const isDecimal = (v: unknown): v is string => isString(v) && /^-?\d+(\.\d+)?$/.test(v);
const isOptional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v);
const isNullableString = (v: unknown) => v === undefined || v === null || isString(v);
const every = (v: unknown, check: (item: unknown) => boolean): v is unknown[] =>
	Array.isArray(v) && v.every(check);

function isOfferingPrice(v: unknown): boolean {
	if (!isObject(v) || !isDecimal(v.amount) || !isString(v.currency)) return false;
	switch (v.kind) {
		case 'FIXED':
			return true;
		case 'PER_QUANTITY':
			return isString(v.dimension);
		case 'PER_DURATION':
			return isString(v.interval);
		default:
			return false;
	}
}

function isOffering(v: unknown, category: string): boolean {
	return (
		isObject(v) &&
		isString(v.key) &&
		v.category === category &&
		isString(v.displayName) &&
		isNullableString(v.description) &&
		isOptional(v.price, isOfferingPrice) &&
		// The public form omits disabled (and retired) offerings: a DISABLED one here is off-contract,
		// and must never reach the page dressed up as "temporarily unavailable".
		v.selectionState === 'ENABLED' &&
		(v.availability === 'AVAILABLE' || v.availability === 'UNAVAILABLE')
	);
}

/** The input union this UI renders. An input type it doesn't know can't be answered: fail closed. */
function isInput(v: unknown): boolean {
	if (!isObject(v)) return false;
	switch (v.type) {
		case 'TEXT':
			return isInt(v.minLength, 0) && isInt(v.maxLength, 0) && isOptional(v.pattern, isString);
		case 'EMAIL':
			return isInt(v.maxLength, 1);
		case 'DATE':
			return true;
		case 'INTEGER':
			return isInt(v.minimum);
		case 'BOOLEAN':
			return typeof v.defaultValue === 'boolean';
		case 'INTEGER_CHOICE':
			return every(v.options, (o) => isObject(o) && isInt(o.value) && isString(o.label));
		case 'STRING_CHOICE':
			return every(v.options, (o) => isObject(o) && isString(o.value) && isString(o.label));
		case 'OFFERING_CHOICE':
			return (
				isString(v.category) &&
				isInt(v.minSelections, 0) &&
				isOptional(v.maxSelections, (m) => isInt(m, 1)) &&
				every(v.options, (o) => isOffering(o, v.category as string))
			);
		default:
			return false;
	}
}

function isField(v: unknown): boolean {
	return (
		isObject(v) &&
		isString(v.key) &&
		isString(v.label) &&
		isNullableString(v.description) &&
		isString(v.submissionPointer) &&
		v.submissionPointer.startsWith('/') &&
		typeof v.required === 'boolean' &&
		isInput(v.input) &&
		// The control is only a hint: any value is acceptable, the input decides the semantics.
		isObject(v.presentation) &&
		isString(v.presentation.control)
	);
}

function isSection(v: unknown): boolean {
	return (
		isObject(v) &&
		isString(v.key) &&
		isString(v.title) &&
		isNullableString(v.description) &&
		typeof v.optional === 'boolean' &&
		every(v.fields, isField)
	);
}

function isPricingPreview(v: unknown): boolean {
	return (
		isObject(v) &&
		isString(v.currency) &&
		isString(v.guestQuantityDimension) &&
		isDecimal(v.perGuestAmount) &&
		every(
			v.durationOptions,
			(d) =>
				isObject(d) &&
				isInt(d.durationMinutes, 1) &&
				isDecimal(d.baseServiceAmount) &&
				every(
					d.offeringContributions,
					(c) => isObject(c) && isString(c.offeringKey) && isDecimal(c.amount)
				)
		) &&
		isObject(v.toppingAdjustment) &&
		isString(v.toppingAdjustment.category) &&
		isInt(v.toppingAdjustment.includedSelections, 0) &&
		isDecimal(v.toppingAdjustment.additionalSelectionPerGuestAmount)
	);
}

/** GET /inquiry-form's documented shape, with unique field keys (they name the answers). */
export function isInquiryForm(v: unknown): v is InquiryForm {
	if (
		!isObject(v) ||
		!isInt(v.definitionVersion, 1) ||
		!isString(v.catalogId) ||
		!isInt(v.catalogRevision, 1) ||
		!every(v.sections, isSection) ||
		!isPricingPreview(v.pricingPreview)
	) {
		return false;
	}
	const keys = (v.sections as { fields: { key: string }[] }[]).flatMap((s) =>
		s.fields.map((f) => f.key)
	);
	return new Set(keys).size === keys.length;
}

const INT32_MAX = 2_147_483_647;
const isCount = (v: unknown) => isInt(v, 1) && v <= INT32_MAX;
/** No property beyond `keys`: nothing unexpected (such as an amount) can ride along. */
const hasOnly = (v: Json, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));

/**
 * A POST /inquiries body in exactly its transport shape, with no other properties: what a replayed
 * request must be before it is sent again. Structure only; the backend validates the meaning.
 */
export function isCreateInquiryRequest(v: unknown): v is CreateInquiryRequest {
	if (
		!isObject(v) ||
		!hasOnly(v, ['name', 'email', 'message', 'pricingInputs', 'zipCode', 'eventDate', 'eventType'])
	) {
		return false;
	}
	if (![v.name, v.email, v.zipCode, v.eventDate].every(isString)) return false;
	if (!isOptional(v.message, isString)) return false;
	if (!INQUIRY_EVENT_TYPES.includes(v.eventType as InquiryEventType)) return false;
	const pricing = v.pricingInputs;
	return (
		isObject(pricing) &&
		hasOnly(pricing, [
			'catalogRevision',
			'guestCount',
			'guestCountIsMinimum',
			'durationMinutes',
			'selections'
		]) &&
		isCount(pricing.catalogRevision) &&
		isCount(pricing.guestCount) &&
		typeof pricing.guestCountIsMinimum === 'boolean' &&
		isCount(pricing.durationMinutes) &&
		every(
			pricing.selections,
			(s) =>
				isObject(s) &&
				hasOnly(s, ['category', 'offerings']) &&
				isString(s.category) &&
				every(s.offerings, isString)
		)
	);
}

/** POST /estimate-preview's documented shape. */
export function isEstimatePreview(v: unknown): v is EstimatePreview {
	return (
		isObject(v) &&
		isInt(v.catalogRevision, 1) &&
		typeof v.guestCountIsMinimum === 'boolean' &&
		isDecimal(v.subtotal) &&
		isDecimal(v.taxAmount) &&
		isDecimal(v.total) &&
		isString(v.currency) &&
		every(
			v.lines,
			(l) =>
				isObject(l) &&
				isString(l.description) &&
				isOptional(l.subDescription, isString) &&
				isOptional(l.quantity, isString) &&
				isDecimal(l.unitPrice) &&
				isDecimal(l.subtotal) &&
				isDecimal(l.taxAmount) &&
				isDecimal(l.total) &&
				isString(l.currency)
		)
	);
}
