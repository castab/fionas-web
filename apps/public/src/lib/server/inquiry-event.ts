import { INQUIRY_EVENT_TYPES, type PricedInquiry } from '@fionas/shared';

/*
 * The InquirySubmitted v1 event: what /book publishes to NATS JetStream for every accepted
 * request. Its contract is ../../../../../asyncapi.yaml (channel `inquirySubmittedV1`), and
 * inquiry-event.test.ts validates what this module builds against that document's schema. Any
 * change here updates the AsyncAPI document and follows its versioning policy. The stream and
 * subject are also set up by scripts/lib/nats-stream.mjs.
 */

/** The JetStream stream that must capture the subject (sent as the PubAck expectation). */
export const INQUIRY_STREAM = 'FIONAS_INQUIRIES';
export const INQUIRY_SUBMITTED_SUBJECT = 'fionas.inquiries.submitted.v1';
export const INQUIRY_SUBMITTED_TYPE = 'fionas.inquiry.submitted';
export const INQUIRY_SCHEMA_VERSION = 1;
export const EVENT_SOURCE = 'fionas-web';
/** The online guest limit the menu enforces; the schema's `guestCount` maximum. */
const MAX_GUESTS = 300;

export type InquirySubmittedEvent = {
	schemaVersion: typeof INQUIRY_SCHEMA_VERSION;
	type: typeof INQUIRY_SUBMITTED_TYPE;
	/** Unique per submission and the same for every delivery of it: consumers deduplicate on it. */
	id: string;
	/** When this server accepted and priced the submission (ISO 8601, UTC). */
	occurredAt: string;
	source: typeof EVENT_SOURCE;
	data: PricedInquiry & { priceRevision: string };
};

/** What the customer's confirmation is built from: the event's public-safe identity. */
export type InquiryReceipt = { id: string; createdAt: string };

/**
 * The one event for a priced inquiry. Its `id` and `occurredAt` are fixed here, once, and the
 * event is then sealed (inquiry-replay.ts), so every delivery publishes the identical bytes.
 */
export function buildInquiryEvent(
	inquiry: PricedInquiry,
	priceRevision: string,
	{ id = crypto.randomUUID(), now = Date.now() }: { id?: string; now?: number } = {}
): InquirySubmittedEvent {
	return {
		schemaVersion: INQUIRY_SCHEMA_VERSION,
		type: INQUIRY_SUBMITTED_TYPE,
		id,
		occurredAt: new Date(now).toISOString(),
		source: EVENT_SOURCE,
		data: { ...inquiry, priceRevision }
	};
}

export const receiptOf = (event: InquirySubmittedEvent): InquiryReceipt => ({
	id: event.id,
	createdAt: event.occurredAt
});

/** The NATS headers every delivery carries besides `Nats-Msg-Id` (asyncapi.yaml). */
export const INQUIRY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
	'Content-Type': 'application/json',
	'Fionas-Event-Type': INQUIRY_SUBMITTED_TYPE,
	'Fionas-Schema-Version': String(INQUIRY_SCHEMA_VERSION)
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LINE_KEYS = [
	'description',
	'subDescription',
	'quantity',
	'unitPrice',
	'taxAmount',
	'currency'
];
const DATA_KEYS = [
	'name',
	'email',
	'message',
	'zipCode',
	'eventDate',
	'eventType',
	'requestedService',
	'priceRevision',
	'lines'
];
const SERVICE_KEYS = ['guestCount', 'guestCountIsMinimum', 'items', 'pricingReference'];

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';
const onlyKeys = (v: Record<string, unknown>, allowed: string[]) =>
	Object.keys(v).every((k) => allowed.includes(k));
const units = (amount: string): bigint => {
	const [whole, fraction = ''] = amount.split('.');
	return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
};

function isPricedLine(l: unknown): boolean {
	if (!isObject(l) || !onlyKeys(l, LINE_KEYS)) return false;
	if (
		!text(l.description) ||
		!l.description.trim() ||
		l.description.length > 200 ||
		(l.subDescription !== undefined &&
			(!text(l.subDescription) || l.subDescription.length > 500)) ||
		!text(l.unitPrice) ||
		!/^[0-9]{1,9}(\.[0-9]{1,12})?$/.test(l.unitPrice) ||
		!text(l.taxAmount) ||
		!/^[0-9]{1,9}(\.[0-9]{1,2})?$/.test(l.taxAmount) ||
		l.currency !== 'USD' ||
		(l.quantity !== undefined &&
			(!text(l.quantity) ||
				!/^[0-9]{1,9}(\.[0-9]{1,6})?$/.test(l.quantity) ||
				units(l.quantity) === 0n))
	)
		return false;
	// Every line settles to whole cents: exact arithmetic, never rounded.
	const subtotal =
		l.quantity === undefined
			? units(l.unitPrice)
			: (units(l.unitPrice) * units(l.quantity as string)) / 10n ** 18n;
	return subtotal % 10n ** 16n === 0n;
}

function isRequestedService(s: unknown): boolean {
	return (
		isObject(s) &&
		// There is no service duration: a command carrying one was not built by this server.
		onlyKeys(s, SERVICE_KEYS) &&
		Number.isInteger(s.guestCount) &&
		(s.guestCount as number) >= 1 &&
		(s.guestCount as number) <= MAX_GUESTS &&
		(s.guestCountIsMinimum === undefined || typeof s.guestCountIsMinimum === 'boolean') &&
		(s.pricingReference === undefined || text(s.pricingReference)) &&
		(s.items === undefined ||
			(Array.isArray(s.items) &&
				s.items.every(
					(i) =>
						isObject(i) &&
						onlyKeys(i, ['label', 'group', 'key']) &&
						text(i.label) &&
						(i.group === undefined || text(i.group)) &&
						(i.key === undefined || text(i.key))
				)))
	);
}

/**
 * Whether `value` is an InquirySubmitted v1 event this server could have built: the same
 * structure and exact-decimal rules as the AsyncAPI schema. Guards replayed envelopes, which are
 * signed but still checked before anything is published.
 */
export function isInquirySubmittedEvent(value: unknown): value is InquirySubmittedEvent {
	if (
		!isObject(value) ||
		!onlyKeys(value, ['schemaVersion', 'type', 'id', 'occurredAt', 'source', 'data'])
	)
		return false;
	const d = value.data;
	return (
		value.schemaVersion === INQUIRY_SCHEMA_VERSION &&
		value.type === INQUIRY_SUBMITTED_TYPE &&
		value.source === EVENT_SOURCE &&
		text(value.id) &&
		UUID.test(value.id) &&
		text(value.occurredAt) &&
		!Number.isNaN(Date.parse(value.occurredAt)) &&
		isObject(d) &&
		onlyKeys(d, DATA_KEYS) &&
		text(d.name) &&
		d.name.length >= 1 &&
		d.name.length <= 200 &&
		text(d.email) &&
		d.email.length <= 254 &&
		EMAIL.test(d.email) &&
		(d.message === undefined ||
			(text(d.message) && d.message.length >= 1 && d.message.length <= 4000)) &&
		text(d.zipCode) &&
		/^[0-9]{5}$/.test(d.zipCode) &&
		text(d.eventDate) &&
		DATE.test(d.eventDate) &&
		INQUIRY_EVENT_TYPES.includes(d.eventType as (typeof INQUIRY_EVENT_TYPES)[number]) &&
		isRequestedService(d.requestedService) &&
		text(d.priceRevision) &&
		d.priceRevision.length >= 1 &&
		d.priceRevision.length <= 160 &&
		Array.isArray(d.lines) &&
		d.lines.length >= 1 &&
		d.lines.length <= 100 &&
		d.lines.every(isPricedLine)
	);
}
