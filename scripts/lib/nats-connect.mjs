// How the operator scripts connect to NATS. Defaults target the local compose server
// (compose.yaml) as its dev-only admin user; flags or NATS_ADMIN_* env point them elsewhere.
// Credentials are never printed.

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { connect, credsAuthenticator } from '@nats-io/transport-node';

export const LOCAL_SERVER = 'nats://127.0.0.1:4222';
const LOCAL_ADMIN = { user: 'fionas-admin', pass: 'fionas-admin-dev' };

/** `parseArgs` options every script accepts. */
export const CONNECTION_OPTIONS = {
	server: { type: 'string' },
	creds: { type: 'string' },
	user: { type: 'string' },
	password: { type: 'string' }
};

export const CONNECTION_USAGE = `Connection (flag, else env, else the local compose server)
  --server <urls>     NATS_ADMIN_URL       default ${LOCAL_SERVER} (comma-separated for a cluster)
  --creds <file>      NATS_ADMIN_CREDS     a .creds file (decentralized JWT auth)
  --user <name>       NATS_ADMIN_USER      default ${LOCAL_ADMIN.user} (local dev only)
  --password <pass>   NATS_ADMIN_PASSWORD  default: that user's dev-only password`;

/** Where and how to connect, from parsed flags and env. */
export function connectionSettings(values, env = process.env) {
	const servers = (values.server ?? env.NATS_ADMIN_URL ?? LOCAL_SERVER)
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const creds = values.creds ?? env.NATS_ADMIN_CREDS;
	if (creds) return { servers, creds };
	const user = values.user ?? env.NATS_ADMIN_USER ?? LOCAL_ADMIN.user;
	const pass =
		values.password ??
		env.NATS_ADMIN_PASSWORD ??
		(user === LOCAL_ADMIN.user ? LOCAL_ADMIN.pass : undefined);
	return { servers, user, pass };
}

/** One connection, named after the calling script, that fails fast instead of reconnecting. */
export async function connectAs(name, { servers, creds, user, pass }) {
	return connect({
		servers,
		name,
		timeout: 5000,
		maxReconnectAttempts: 0,
		...(creds
			? { authenticator: credsAuthenticator(await readFile(creds)) }
			: user
				? { user, pass }
				: {})
	});
}

/** Connects or exits with a hint; never prints credentials. */
export async function connectOrExit(name, values) {
	const settings = connectionSettings(values);
	try {
		return await connectAs(name, settings);
	} catch (e) {
		console.error(`✗ Could not connect to ${settings.servers.join(', ')}: ${e.message}`);
		console.error('  Is NATS running? Locally: npm run nats:up');
		process.exit(1);
	}
}

/** `parseArgs` that prints usage and exits on a bad flag or --help. */
export function parseCommandLine(options, usage) {
	let values;
	try {
		({ values } = parseArgs({ options: { ...options, help: { type: 'boolean', short: 'h' } } }));
	} catch (e) {
		console.error(`${e.message}\n\n${usage}`);
		process.exit(2);
	}
	if (values.help) {
		console.log(usage);
		process.exit(0);
	}
	return values;
}
