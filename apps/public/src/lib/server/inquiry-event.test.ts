import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Parser } from '@asyncapi/parser';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { answersFromFormData, prepareInquiry } from '@fionas/shared';
import { parsePriceBook, priceInquiry, projectForm } from './price-book.js';
import {
	buildInquiryEvent,
	INQUIRY_HEADERS,
	INQUIRY_STREAM,
	INQUIRY_SUBMITTED_SUBJECT,
	isInquirySubmittedEvent,
	type InquirySubmittedEvent
} from './inquiry-event.js';

/*
 * The contract guard: what this server publishes must match the AsyncAPI document consumers
 * read (asyncapi.yaml at the repository root).
 */

const specPath = fileURLToPath(new URL('../../../../../asyncapi.yaml', import.meta.url));
const { document, diagnostics } = await new Parser().parse(readFileSync(specPath, 'utf8'));
if (!document) throw new Error(`asyncapi.yaml does not parse: ${JSON.stringify(diagnostics)}`);
const message = document.components().messages().get('InquirySubmittedV1')!;

function compile(schema: unknown): ValidateFunction {
	const ajv = new Ajv({ strict: false, allErrors: true });
	addFormats(ajv);
	return ajv.compile(schema as object);
}
const validatePayload = compile(message.payload()!.json());
const validateHeaders = compile(message.headers()!.json());

const book = parsePriceBook(
	readFileSync(new URL('../../../e2e/fixtures/prices.synthetic.yaml', import.meta.url), 'utf8')
);

function built(extra: Record<string, string | string[]> = {}): InquirySubmittedEvent {
	const f = new FormData();
	const fields: Record<string, string | string[]> = {
		name: 'Jane Doe',
		email: 'jane@example.com',
		zipCode: '93720',
		eventDate: '2026-12-05',
		eventType: 'WEDDING',
		guestCount: '120',
		'offering:hand-scooped-flavor': [
			'hand-scooped-chocolate-chip',
			'hand-scooped-mint-chip',
			'hand-scooped-butter-pecan',
			'hand-scooped-strawberry'
		],
		'offering:topping': [
			'rainbow-sprinkles',
			'chocolate-sauce',
			'caramel-sauce',
			'crushed-oreo',
			'whipped-cream',
			'gummy-bears'
		],
		'offering:cone-option': ['cup', 'cake-cone'],
		...extra
	};
	for (const [key, value] of Object.entries(fields))
		for (const v of Array.isArray(value) ? value : [value]) f.append(key, v);
	const form = projectForm(book);
	const intent = prepareInquiry(form, answersFromFormData(form, f));
	if (!intent.ok) throw new Error(`Invalid fixture: ${JSON.stringify(intent)}`);
	return buildInquiryEvent(priceInquiry(intent.request, book), book.revision);
}

const errorsOf = (validate: ValidateFunction, value: unknown) =>
	validate(value) ? [] : validate.errors!.map((e) => `${e.instancePath} ${e.message}`);

describe('InquirySubmitted v1 against asyncapi.yaml', () => {
	it('is published on the documented channel', () => {
		const channel = document.channels().get('inquirySubmittedV1')!;
		expect(channel.address()).toBe(INQUIRY_SUBMITTED_SUBJECT);
		expect(document.info().version()).toMatch(/^1\./);
		expect(readFileSync(specPath, 'utf8')).toContain(INQUIRY_STREAM);
	});

	it('builds events that match the payload schema', () => {
		for (const event of [
			built(),
			built({ message: 'Garden reception\nwith a sundae bar' }),
			built({ guestCount: '1' }),
			built({ guestCount: '300' })
		])
			expect(errorsOf(validatePayload, event)).toEqual([]);
	});

	it('sends the documented headers', () => {
		// The JetStream client adds the last two from the publish options (see nats.ts).
		const headers = {
			...INQUIRY_HEADERS,
			'Nats-Msg-Id': crypto.randomUUID(),
			'Nats-Expected-Stream': INQUIRY_STREAM
		};
		expect(errorsOf(validateHeaders, headers)).toEqual([]);
		expect(errorsOf(validateHeaders, INQUIRY_HEADERS)).not.toEqual([]);
	});

	it('accepts the documented example', () => {
		const example = message.examples().all()[0].payload();
		expect(isInquirySubmittedEvent(example)).toBe(true);
		expect(errorsOf(validatePayload, example)).toEqual([]);
	});

	it('round-trips through JSON unchanged, so replays publish identical bytes', () => {
		const event = built();
		expect(JSON.stringify(JSON.parse(JSON.stringify(event)))).toBe(JSON.stringify(event));
		expect(isInquirySubmittedEvent(JSON.parse(JSON.stringify(event)))).toBe(true);
	});

	type Mutation = [string, (e: InquirySubmittedEvent & Record<string, unknown>) => void];
	const mutations: Mutation[] = [
		['an unknown top-level field', (e) => (e.extra = true)],
		['another schema version', (e) => ((e as { schemaVersion: number }).schemaVersion = 2)],
		['a non-UUID id', (e) => (e.id = 'not-a-uuid')],
		['a total', (e) => ((e.data as unknown as Record<string, unknown>).total = '100.00')],
		[
			'a service duration',
			(e) => ((e.data.requestedService as Record<string, unknown>).durationMinutes = 120)
		],
		['too many guests', (e) => (e.data.requestedService.guestCount = 301)],
		['no lines', (e) => (e.data.lines = [])],
		['a numeric amount', (e) => ((e.data.lines[0] as { unitPrice: unknown }).unitPrice = 101)],
		['another currency', (e) => (e.data.lines[0].currency = 'EUR')],
		['an unknown event type', (e) => ((e.data as { eventType: string }).eventType = 'PARTY')],
		['an empty price revision', (e) => (e.data.priceRevision = '')],
		['a malformed ZIP code', (e) => (e.data.zipCode = '9372')]
	];

	it.each(mutations)('rejects %s in both the schema and the replay guard', (_, mutate) => {
		const event = built() as InquirySubmittedEvent & Record<string, unknown>;
		mutate(event);
		expect(validatePayload(event)).toBe(false);
		expect(isInquirySubmittedEvent(event)).toBe(false);
	});

	it('refuses a line that does not settle to whole cents (replay guard)', () => {
		const event = built();
		event.data.lines[0] = { ...event.data.lines[0], quantity: '3', unitPrice: '0.333' };
		expect(isInquirySubmittedEvent(event)).toBe(false);
	});
});
