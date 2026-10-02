import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formFixture } from '$lib/server/testing/fake-commerce.js';

/*
 * The backend owns which questions and options exist: the UI renders GET /inquiry-form. This fails
 * if a catalog fact from the captured form (an offering or category key, an offering name, a price
 * or pricing-preview amount) shows up as a literal in the app or the packages it is built from.
 */

const appRoot = join(import.meta.dirname, '..');
const sources = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			return entry.name === 'node_modules' || entry.name === 'testing' ? [] : sources(path);
		}
		return /\.(svelte|ts|js)$/.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name)
			? [path]
			: [];
	});

const scanned = [
	...sources(join(appRoot, 'src')),
	...sources(join(appRoot, '../../packages/shared/src')),
	...sources(join(appRoot, '../../packages/ui/src'))
];

const form = formFixture();
const fields = form.sections.flatMap((s) => s.fields);
const options = fields.flatMap((f) => (f.input.type === 'OFFERING_CHOICE' ? f.input.options : []));
const preview = form.pricingPreview;

const catalogFacts = [
	...options.flatMap((o) => [o.key, o.category, o.displayName]),
	...options.flatMap((o) => (o.price ? [o.price.amount] : [])),
	preview.perGuestAmount,
	preview.toppingAdjustment.additionalSelectionPerGuestAmount,
	...preview.durationOptions.map((d) => d.baseServiceAmount)
];

/** The fact as a string literal in code: 'vanilla', "vanilla" or `vanilla`. */
const literal = (fact: string) =>
	new RegExp(`['"\`]${fact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);

describe('no hardcoded catalog', () => {
	it('scans the UI sources and has facts to look for', () => {
		const rel = scanned.map((p) => relative(appRoot, p).split(sep).join('/'));
		expect(rel).toContain('src/lib/components/inquiry-field.svelte');
		expect(rel).toContain('src/routes/book/+page.svelte');
		expect(catalogFacts).toContain('horchata');
		expect(catalogFacts).toContain('0.50');
	});

	it('finds no offering keys, names, categories or prices in the code', () => {
		const offenders = scanned.flatMap((path) => {
			const text = readFileSync(path, 'utf8');
			return catalogFacts
				.filter((fact) => literal(fact).test(text))
				.map((fact) => `${relative(appRoot, path)}: ${fact}`);
		});
		expect(offenders).toEqual([]);
	});
});
