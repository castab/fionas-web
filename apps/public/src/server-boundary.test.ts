import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * The NATS settings and credentials live in private env and are read only by server modules; the
 * connection exists only in server memory. SvelteKit already refuses to bundle `$env/*private` or
 * `$lib/server` into the client; this keeps the rule visible and fails fast. Shared packages are
 * bundled into the browser, so they are checked too.
 */

const appRoot = join(import.meta.dirname, '..');
const sources = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path);
		return /\.(svelte|ts|js)$/.test(entry.name) ? [path] : [];
	});
const rel = (path: string) => relative(appRoot, path).split(sep).join('/');

/** Runs only on the server: `$lib/server/**`, `*.server.ts`, `+server.ts`, and tests. */
const isServerOnly = (path: string) => {
	const r = rel(path);
	return (
		r.startsWith('src/lib/server/') ||
		/\.server\.(ts|js)$/.test(r) ||
		/(^|\/)\+server\.(ts|js)$/.test(r) ||
		/\.test\.(ts|js)$/.test(r)
	);
};

const clientReachable = [
	...sources(join(appRoot, 'src')).filter((path) => !isServerOnly(path)),
	...sources(join(appRoot, '../../packages/ui/src')),
	...sources(join(appRoot, '../../packages/shared/src'))
];

/** Application sources, without tests and test doubles. */
const appSources = () =>
	sources(join(appRoot, 'src')).filter((path) => !/\.test\.ts$|[\\/]testing[\\/]/.test(path));

const secrets =
	/\$env\/(static|dynamic)\/private|\$lib\/server|NATS_(URL|USER|PASSWORD|CREDS_FILE)|FIONAS_(PRICES_FILE|REPLAY_SECRET)|@nats-io|process\.env/;

describe('server-only event publishing', () => {
	it('finds client-reachable sources to check', () => {
		expect(clientReachable.some((p) => p.endsWith('+page.svelte'))).toBe(true);
		expect(clientReachable.some((p) => p.endsWith('estimate-panel.svelte'))).toBe(true);
	});

	it('keeps private env, NATS and $lib/server out of client-reachable code', () => {
		const offenders = clientReachable
			.filter((path) => secrets.test(readFileSync(path, 'utf8')))
			.map((path) => relative(appRoot, path));
		expect(offenders).toEqual([]);
	});

	it('reads the NATS settings from env only in the connection module', () => {
		const readers = appSources()
			.filter((path) => /env\.NATS_/.test(readFileSync(path, 'utf8')))
			.map(rel);
		expect(readers).toEqual(['src/lib/server/nats.ts']);
	});

	it('opens NATS connections only in the connection module', () => {
		const connectors = appSources()
			.filter((path) => /\bconnect\(/.test(readFileSync(path, 'utf8')))
			.map(rel);
		expect(connectors).toEqual(['src/lib/server/nats.ts']);
	});
});
