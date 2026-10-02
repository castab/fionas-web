import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * The commerce service credential lives in private env and is read only by server modules; the
 * access tokens it buys exist only in server memory. SvelteKit
 * already refuses to bundle `$env/*private` or `$lib/server` into the client; this keeps the rule
 * visible and fails fast. Shared packages are bundled into the browser, so they are checked too.
 */

const appRoot = join(import.meta.dirname, '..');
const sources = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path);
		return /\.(svelte|ts|js)$/.test(entry.name) ? [path] : [];
	});

/** Runs only on the server: `$lib/server/**`, `*.server.ts`, `+server.ts`, and tests. */
const isServerOnly = (path: string) => {
	const rel = relative(appRoot, path).split(sep).join('/');
	return (
		rel.startsWith('src/lib/server/') ||
		/\.server\.(ts|js)$/.test(rel) ||
		/(^|\/)\+server\.(ts|js)$/.test(rel) ||
		/\.test\.(ts|js)$/.test(rel)
	);
};

const clientReachable = [
	...sources(join(appRoot, 'src')).filter((path) => !isServerOnly(path)),
	...sources(join(appRoot, '../../packages/ui/src')),
	...sources(join(appRoot, '../../packages/shared/src'))
];

const secrets =
	/\$env\/(static|dynamic)\/private|\$lib\/server|COMMERCE_SERVICE_(ID|CREDENTIAL)|\/auth\/service\/token|process\.env/;

describe('server-only commerce access', () => {
	it('finds client-reachable sources to check', () => {
		expect(clientReachable.some((p) => p.endsWith('+page.svelte'))).toBe(true);
		expect(clientReachable.some((p) => p.endsWith('estimate-panel.svelte'))).toBe(true);
	});

	it('keeps private env, the service credential and $lib/server out of client-reachable code', () => {
		const offenders = clientReachable
			.filter((path) => secrets.test(readFileSync(path, 'utf8')))
			.map((path) => relative(appRoot, path));
		expect(offenders).toEqual([]);
	});

	it('reads the service credential from env only in the commerce adapter', () => {
		const readers = sources(join(appRoot, 'src'))
			.filter((path) => !/\.test\.ts$/.test(path))
			.filter((path) => /env\.COMMERCE_SERVICE_/.test(readFileSync(path, 'utf8')))
			.map((path) => relative(appRoot, path).split(sep).join('/'));
		expect(readers).toEqual(['src/lib/server/commerce.ts']);
	});

	it('exchanges the credential for tokens only in the server-side service-auth module', () => {
		const exchangers = sources(join(appRoot, 'src'))
			.filter((path) => !/\.test\.ts$|[\\/]testing[\\/]/.test(path))
			.filter((path) => readFileSync(path, 'utf8').includes('/auth/service/token'))
			.map((path) => relative(appRoot, path).split(sep).join('/'));
		expect(exchangers).toEqual(['src/lib/server/service-auth.ts']);
	});
});
