import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { PRICE_KEYS, MENU_SECTIONS } from './menu.js';
const state = vi.hoisted(() => ({ env: {} as Record<string, string> }));
vi.mock('$env/dynamic/private', () => ({ env: state.env }));
import { parsePriceBook, getPriceBook, projectForm } from './price-book.js';
import { sealReplay, openReplay } from './inquiry-replay.js';
const source = readFileSync(
	new URL('../../../e2e/fixtures/prices.synthetic.yaml', import.meta.url),
	'utf8'
);
describe('restricted private price book', () => {
	it('accepts synthetic quoted exact values, exact key set and immutable snapshot', () => {
		const book = parsePriceBook(source);
		expect(Object.keys(book.amounts).sort()).toEqual([...PRICE_KEYS].sort());
		expect(Object.isFrozen(book.amounts)).toBe(true);
		expect(projectForm(book).priceRevision).toBe('synthetic-1');
		expect(projectForm(book).pricingPreview.baseServiceAmount).toBe('101.00');
		expect(PRICE_KEYS).not.toContain('event.hourly');
	});
	it('fails without configured file instead of using demo prices', () =>
		expect(() => getPriceBook()).toThrow());
	it('fails for a missing file and an invalid file, then caches one immutable valid snapshot', async () => {
		vi.resetModules();
		const { getPriceBook: read } = await import('./price-book.js');
		state.env.FIONAS_PRICES_FILE = fileURLToPath(
			new URL('./missing-price-book.yaml', import.meta.url)
		);
		expect(() => read()).toThrow();
		state.env.FIONAS_PRICES_FILE = fileURLToPath(new URL('./price-book.ts', import.meta.url));
		expect(() => read()).toThrow();
		state.env.FIONAS_PRICES_FILE = fileURLToPath(
			new URL('../../../e2e/fixtures/prices.synthetic.yaml', import.meta.url)
		);
		const book = read();
		state.env.FIONAS_PRICES_FILE = 'missing-after-success.yaml';
		expect(read()).toBe(book);
		delete state.env.FIONAS_PRICES_FILE;
	});
	it.each([
		source.replace("revision: 'synthetic-1'", ''),
		source.replace("revision: 'synthetic-1'", "revision: ''"),
		source.replace("'101.00'", '101.00'),
		source.replace("'101.00'", "'-1.00'"),
		source.replace("'101.00'", "'NaN'"),
		source.replace("'101.00'", "'1e2'"),
		source.replace("'101.00'", "'1.001'"),
		source.replace("'101.00'", "'1.0000000000001'"),
		source.replace("  event.base: '101.00'", ''),
		source + "  event.base: '0.00'\n",
		source + "  unknown: '0.00'\n",
		source + 'amounts:\n',
		source + '  <<: *prices\n',
		source + "other: 'value'\n",
		// There is no service duration, so an hourly rate is an unknown key.
		source + "  event.hourly: '20.00'\n"
	])('rejects invalid schema, ambiguity or unsupported arithmetic %#', (invalid) =>
		expect(() => parsePriceBook(invalid)).toThrow()
	);
	it('keeps seven hand scooped, nine topping and three cone choices, no soft serve, notes always present', () => {
		const fields = MENU_SECTIONS.flatMap((s) => s.fields);
		const choice = (category: string) =>
			fields.find((f) => f.input.type === 'OFFERING_CHOICE' && f.input.category === category)!;
		expect(
			fields.some(
				(f) => f.input.type === 'OFFERING_CHOICE' && f.input.category === 'soft-serve-flavor'
			)
		).toBe(false);
		expect(choice('hand-scooped-flavor').input).toHaveProperty('options.length', 7);
		expect(choice('topping').input).toHaveProperty('options.length', 9);
		expect(choice('cone-option').input).toMatchObject({ minSelections: 1, maxSelections: 3 });
		expect(choice('cone-option').input).toHaveProperty('options.length', 3);
		expect(fields.find((f) => f.key === 'message')).toMatchObject({
			required: false,
			presentation: { control: 'TEXTAREA' }
		});
		expect(JSON.stringify(MENU_SECTIONS)).not.toMatch(/"(?:amount|unitPrice|taxAmount|total)":/);
		expect(fields.map((f) => f.key)).not.toContain('durationMinutes');
		expect(fields.find((f) => f.key === 'guestCount')?.input).toEqual({
			type: 'INTEGER',
			minimum: 1,
			maximum: 300,
			defaultValue: 50
		});
	});
});
describe('signed replay integrity', () => {
	const secret = 'synthetic-only-signing-secret-32-bytes';
	const command = {
		name: 'Jane',
		email: 'jane@example.com',
		zipCode: '02134',
		eventDate: '2026-12-05',
		eventType: 'BIRTHDAY' as const,
		requestedService: { guestCount: 8 },
		lines: [
			{
				description: 'Synthetic service',
				quantity: '8',
				unitPrice: '0.125',
				taxAmount: '0.00',
				currency: 'USD'
			}
		]
	};
	it('roundtrips the identical priced command', () =>
		expect(openReplay(sealReplay(command, 'key', secret, 100), 'key', secret, 200)).toEqual(
			command
		));
	it.each([
		['expired', 100 + 24 * 60 * 60 * 1000 + 1],
		['future', 99]
	])('rejects %s envelopes', (_, now) =>
		expect(openReplay(sealReplay(command, 'key', secret, 100), 'key', secret, now)).toBeNull()
	);
	it('rejects missing signatures, alternate keys and wrong secrets', () => {
		const e = sealReplay(command, 'key', secret, 100);
		expect(openReplay(e, 'other', secret, 100)).toBeNull();
		expect(openReplay(e, 'key', secret + 'x', 100)).toBeNull();
		expect(openReplay(e.split('.')[0], 'key', secret, 100)).toBeNull();
		expect(openReplay(e + '!', 'key', secret, 100)).toBeNull();
	});
});
