import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it, expect } from 'vitest';
const files = (p: string): string[] =>
	readdirSync(p, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? files(join(p, e.name)) : e.name.endsWith('.test.ts') ? [] : [join(p, e.name)]
	);
it('never calls removed backend catalog APIs', () => {
	const offenders = files(join(import.meta.dirname, 'lib'))
		.filter((p) => /\.(ts|svelte)$/.test(p) && !p.includes('testing'))
		.filter((p) =>
			/(?:request|fetch)\([^\n]*(?:\/inquiry-form|\/offering-catalog|\/estimate-preview)/.test(
				readFileSync(p, 'utf8')
			)
		);
	expect(offenders).toEqual([]);
});
