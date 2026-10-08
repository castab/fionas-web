import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { offeringCatalog, stubPricing } from '../e2e/catalog-fixture.mjs';

/*
 * The quote builder renders whatever GET /offering-catalog and GET /inquiry-form send, and Commerce
 * prices every quote. This fails if a catalog fact from the test catalog (an offering or category
 * key or name, a price or a policy amount) shows up as a literal in the admin app's code.
 */

const appRoot = join(import.meta.dirname, '..');
const sources = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sources(path);
		return /\.(svelte|ts|js)$/.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name)
			? [path]
			: [];
	});
const scanned = sources(join(appRoot, 'src'));

const catalog = offeringCatalog();
const catalogFacts = [
	...catalog.categories.flatMap((c) => [c.key, c.displayName]),
	...catalog.categories.flatMap((c) =>
		c.offerings.flatMap((o: { key: string; displayName: string; price?: { amount: string } }) => [
			o.key,
			o.displayName,
			...(o.price ? [o.price.amount] : [])
		])
	),
	...Object.values(stubPricing.base),
	stubPricing.perGuest,
	stubPricing.extraTopping
];

/** The fact as a string literal in code: 'vanilla', "vanilla" or `vanilla`. */
const literal = (fact: string) =>
	new RegExp(`['"\`]${fact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);

describe('no hardcoded catalog in the admin quote builder', () => {
	it('scans the builder sources and has facts to look for', () => {
		const rel = scanned.map((p) => relative(appRoot, p).split(sep).join('/'));
		expect(rel).toContain('src/lib/quote-builder.ts');
		expect(rel).toContain('src/lib/components/requests/quote-builder/service-picks.svelte');
		expect(catalogFacts).toContain('horchata');
		expect(catalogFacts).toContain('0.75');
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
