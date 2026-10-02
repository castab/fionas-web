// Mint the credentials apps/public needs to talk to fionas-commerce as SERVICE:fionas-web.
//
// Asks for the backend URL and an administrator login, then uses that admin session to make sure
// the service, its `fionas.web` role (exactly three permissions) and the assignment exist, and
// creates a new credential for it. Writes COMMERCE_API_URL, COMMERCE_SERVICE_ID and
// COMMERCE_SERVICE_CREDENTIAL into apps/public/.env.
//
// Operator tool, not part of either app: it signs in as a USER, only to provision. Safe to re-run
// (it looks before creating). It never revokes anything. See README, "Service authentication".

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SERVICE_NAME = 'fionas-web';
const ROLE = {
	key: 'fionas.web',
	displayName: 'Fiona web frontend',
	description: 'Public site: read the inquiry form, preview estimates, create inquiries',
	// Exactly these, never staff, offering-management, financial, role or credential permissions.
	permissions: [
		'fionas.inquiry-form.read',
		'fionas.estimate-preview.create',
		'fionas.inquiries.create'
	]
};
const DEFAULT_URL = 'http://localhost:8080';
const TIMEOUT_MS = 10_000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultEnvFile = path.join(repoRoot, 'apps', 'public', '.env');

const USAGE = `Usage: npm run provision:service -- [options]

Creates (or reuses) SERVICE:${SERVICE_NAME} with role ${ROLE.key} on the commerce backend and
issues a new credential for it, using an administrator login you enter.

Options
  --url <url>         Backend URL (otherwise asked; default: COMMERCE_API_URL in the env file)
  --username <name>   Administrator username (otherwise asked)
  --origin <url>      Origin sent to the backend (default: the backend URL's origin). Must be a
                      trusted origin on the API
  --out <path>        Where to write the variables (default: apps/public/.env)
  --print             Print the variables instead of writing a file (for a host's secret store)
  --yes               Don't ask for confirmation (replace existing values, add another credential)
  -h, --help          Show this help`;

class ProvisionError extends Error {}

// ── Prompts ──────────────────────────────────────────────────────────────────────────────────

/** One readline for the whole run. Lines are pulled from an iterator, so piped input isn't lost. */
function createPrompter({ assumeYes }) {
	let echo = true;
	const output = new Writable({
		write(chunk, encoding, callback) {
			if (echo) process.stdout.write(chunk, encoding);
			callback();
		}
	});
	const rl = createInterface({
		input: process.stdin,
		output,
		terminal: Boolean(process.stdin.isTTY)
	});
	rl.on('SIGINT', () => {
		process.stdout.write('\n');
		process.exit(130);
	});
	const lines = rl[Symbol.asyncIterator]();

	async function ask(question, { secret = false } = {}) {
		process.stdout.write(question);
		echo = !secret;
		const next = await lines.next();
		echo = true;
		if (secret) process.stdout.write('\n');
		if (next.done) throw new ProvisionError('Input ended before every question was answered.');
		return secret ? next.value : next.value.trim();
	}

	async function confirm(question, { defaultYes }) {
		if (assumeYes) return true;
		const answer = (await ask(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
		return answer === '' ? defaultYes : answer === 'y' || answer === 'yes';
	}

	return { ask, confirm, close: () => rl.close() };
}

// ── Backend ──────────────────────────────────────────────────────────────────────────────────

/**
 * One call to the commerce API. Never throws: a network failure is `status: 0`.
 * `session.cookie` is the `name=value` pairs of the admin session's `Set-Cookie` headers.
 */
async function request(session, method, route, json) {
	const headers = { accept: 'application/json', origin: session.origin };
	if (json !== undefined) headers['content-type'] = 'application/json';
	if (session.cookie) headers.cookie = session.cookie;

	let response;
	try {
		response = await fetch(`${session.baseUrl}${route}`, {
			method,
			headers,
			body: json === undefined ? undefined : JSON.stringify(json),
			redirect: 'manual',
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
	} catch (error) {
		return {
			ok: false,
			status: 0,
			code: 'unreachable',
			// Connection failures wrap an AggregateError whose message is empty; its code is the reason.
			message: error.cause?.message || error.cause?.code || error.message,
			setCookies: []
		};
	}

	const text = await response.text();
	let body = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		// Not JSON (a proxy's error page, say): reported by status alone.
	}
	return {
		ok: response.ok,
		status: response.status,
		data: body,
		code: typeof body?.code === 'string' ? body.code : 'unknown',
		message: typeof body?.message === 'string' ? body.message : null,
		retryAfter: response.headers.get('retry-after'),
		setCookies: response.headers.getSetCookie()
	};
}

/** The result's data, or a `ProvisionError` that says what to do about the failure. */
function expectOk(session, result, what) {
	if (result.ok) return result.data;
	let reason;
	if (result.status === 0) {
		reason = `Could not reach ${session.baseUrl}: ${result.message}`;
	} else if (result.status === 401) {
		reason = what.startsWith('POST /auth/login')
			? 'Sign-in rejected: check the username and password.'
			: 'The session was rejected (401). Run the script again.';
	} else if (result.status === 403) {
		reason = what.startsWith('POST /auth/login')
			? `The backend answered 403 forbidden. Is "${session.origin}" one of its trusted origins? ` +
				'Pass --origin <url> to use another.'
			: 'That administrator is not allowed to manage access (403). Use the bootstrap administrator.';
	} else if (result.status === 429) {
		reason = `Too many attempts. Wait${result.retryAfter ? ` ${result.retryAfter} s` : ' a little'} and run again.`;
	} else {
		reason = `${result.code}${result.message ? `: ${result.message}` : ''}`;
	}
	throw new ProvisionError(`${what} → ${result.status || 'no response'}. ${reason}`);
}

async function login(session, username, password) {
	const result = await request(session, 'POST', '/auth/login', { username, password });
	expectOk(session, result, 'POST /auth/login');
	const cookie = result.setCookies.map((header) => header.split(';')[0].trim()).join('; ');
	if (!cookie) throw new ProvisionError('POST /auth/login succeeded but set no session cookie.');
	session.cookie = cookie;
}

/** Best effort: leaving a session behind is harmless, so this never fails the run. */
async function logout(session) {
	await request(session, 'POST', '/auth/logout');
}

const sameSet = (a, b) => a.length === b.length && a.every((item) => b.includes(item));

async function ensureService(session) {
	const { services } = expectOk(
		session,
		await request(session, 'GET', '/admin/access/services'),
		'GET /admin/access/services'
	);
	const existing = services.find((service) => service.name === SERVICE_NAME);
	if (existing) {
		if (String(existing.status).toUpperCase() === 'DISABLED') {
			throw new ProvisionError(
				`Service "${SERVICE_NAME}" (${existing.id}) is disabled. Enable it with ` +
					`PUT /admin/access/services/${existing.id}/status first; the script won't re-enable it.`
			);
		}
		console.log(`Service "${SERVICE_NAME}" already exists (${existing.id}).`);
		return existing.id;
	}
	const created = expectOk(
		session,
		await request(session, 'POST', '/admin/access/services', { name: SERVICE_NAME }),
		'POST /admin/access/services'
	);
	console.log(`Created service "${SERVICE_NAME}" (${created.id}).`);
	return created.id;
}

async function ensureRole(session) {
	const { roles } = expectOk(
		session,
		await request(session, 'GET', '/admin/access/roles'),
		'GET /admin/access/roles'
	);
	const existing = roles.find((role) => role.key === ROLE.key);
	if (!existing) {
		expectOk(
			session,
			await request(session, 'POST', '/admin/access/roles', ROLE),
			'POST /admin/access/roles'
		);
		console.log(`Created role ${ROLE.key} with ${ROLE.permissions.length} permissions.`);
	} else if (!sameSet(existing.permissions, ROLE.permissions)) {
		expectOk(
			session,
			await request(session, 'PUT', `/admin/access/roles/${ROLE.key}/permissions`, {
				permissions: ROLE.permissions
			}),
			`PUT /admin/access/roles/${ROLE.key}/permissions`
		);
		console.log(`Reset role ${ROLE.key} to exactly its ${ROLE.permissions.length} permissions.`);
	} else {
		console.log(
			`Role ${ROLE.key} already grants exactly its ${ROLE.permissions.length} permissions.`
		);
	}
}

async function ensureAssignment(session, serviceId) {
	const base = `/admin/access/services/${serviceId}/roles`;
	const { roles } = expectOk(session, await request(session, 'GET', base), `GET ${base}`);
	if (roles.includes(ROLE.key)) {
		console.log(`Role ${ROLE.key} is already assigned.`);
		return;
	}
	expectOk(
		session,
		await request(session, 'PUT', `${base}/${ROLE.key}`),
		`PUT ${base}/${ROLE.key}`
	);
	console.log(`Assigned role ${ROLE.key} to the service.`);
}

/** Ids of credentials that can still be exchanged for tokens. */
async function activeCredentialIds(session, serviceId) {
	const route = `/admin/access/services/${serviceId}/credentials`;
	const { credentials } = expectOk(session, await request(session, 'GET', route), `GET ${route}`);
	return credentials.filter((credential) => !credential.revoked).map((c) => c.credentialId);
}

async function mintCredential(session, serviceId) {
	const route = `/admin/access/services/${serviceId}/credentials`;
	const label = `${SERVICE_NAME} ${new Date().toISOString().slice(0, 10)}`;
	const issued = expectOk(
		session,
		await request(session, 'POST', route, { label }),
		`POST ${route}`
	);
	if (typeof issued?.secret !== 'string' || !issued.secret) {
		throw new ProvisionError(`POST ${route} returned no secret.`);
	}
	return issued;
}

// ── Env file ─────────────────────────────────────────────────────────────────────────────────

const ENV_SAFE_VALUE = /^[\w./:@+=-]*$/;

function formatEnvValue(value) {
	return ENV_SAFE_VALUE.test(value) ? value : `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

/** `KEY=value` pairs of a dotenv file (unquoted, no interpolation), later lines winning. */
export function parseEnv(text) {
	const values = new Map();
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*?)\s*$/.exec(line);
		if (!match) continue;
		const raw = match[2];
		const quote = raw[0];
		const quoted = (quote === '"' || quote === "'") && raw.length >= 2 && raw.at(-1) === quote;
		values.set(match[1], quoted ? raw.slice(1, -1) : raw.replace(/\s+#.*$/, ''));
	}
	return values;
}

/** Set `entries` in a dotenv file's text: replace a key's line in place, else append; keep the rest. */
export function upsertEnv(text, entries) {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text === '' ? [] : text.split(/\r?\n/);
	if (lines.at(-1) === '') lines.pop();
	for (const [key, value] of Object.entries(entries)) {
		const line = `${key}=${formatEnvValue(value)}`;
		const index = lines.findIndex((existing) =>
			new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(existing)
		);
		if (index === -1) lines.push(line);
		else lines[index] = line;
	}
	return lines.join(eol) + eol;
}

async function readEnvFile(file) {
	try {
		return await readFile(file, 'utf8');
	} catch (error) {
		if (error.code === 'ENOENT') return '';
		throw error;
	}
}

function printVariables(entries) {
	console.log(
		Object.entries(entries)
			.map(([key, value]) => `${key}=${value}`)
			.join('\n')
	);
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────────

function normalizeUrl(input) {
	let url;
	try {
		url = new URL(input);
	} catch {
		throw new ProvisionError(`"${input}" is not a URL. Use something like ${DEFAULT_URL}.`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new ProvisionError(`The backend URL must be http(s), got "${input}".`);
	}
	return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

async function main() {
	const { values: options } = parseArgs({
		options: {
			url: { type: 'string' },
			username: { type: 'string' },
			origin: { type: 'string' },
			// Not `--env-file`: Node itself consumes that flag, even after the script name.
			out: { type: 'string' },
			print: { type: 'boolean', default: false },
			yes: { type: 'boolean', default: false },
			help: { type: 'boolean', short: 'h', default: false }
		}
	});
	if (options.help) {
		console.log(USAGE);
		return;
	}

	const envFile = path.resolve(options.out ?? defaultEnvFile);
	const envText = await readEnvFile(envFile);
	const current = parseEnv(envText);

	const prompter = createPrompter({ assumeYes: options.yes });
	try {
		const defaultUrl = current.get('COMMERCE_API_URL') || DEFAULT_URL;
		const urlAnswer =
			options.url ?? ((await prompter.ask(`Backend URL [${defaultUrl}]: `)) || defaultUrl);
		const baseUrl = normalizeUrl(urlAnswer);
		const origin = options.origin ? new URL(options.origin).origin : new URL(baseUrl).origin;

		const username = options.username ?? ((await prompter.ask('Admin username: ')) || '');
		const password = await prompter.ask('Admin password: ', { secret: true });
		if (!username || !password) throw new ProvisionError('A username and password are required.');

		// Before anything is created: the secret is shown once, so don't mint one that can't be kept.
		if (
			!options.print &&
			(current.get('COMMERCE_SERVICE_CREDENTIAL') || current.get('COMMERCE_SERVICE_ID'))
		) {
			const replace = await prompter.confirm(
				`${path.relative(repoRoot, envFile)} already has service credentials. Replace them?`,
				{ defaultYes: false }
			);
			if (!replace) {
				console.log('Nothing changed. Use --print or --out <path> to keep the existing ones.');
				return;
			}
		}

		const session = { baseUrl, origin, cookie: null };
		await login(session, username, password);
		console.log(`Signed in to ${baseUrl} as ${username}.`);

		let serviceId;
		let issued;
		let previous;
		try {
			serviceId = await ensureService(session);
			await ensureRole(session);
			await ensureAssignment(session, serviceId);

			previous = await activeCredentialIds(session, serviceId);
			if (previous.length > 0) {
				const mint = await prompter.confirm(
					`The service already has ${previous.length} active credential${previous.length === 1 ? '' : 's'} ` +
						'(a new one is added; the old ones keep working). Create another?',
					{ defaultYes: true }
				);
				if (!mint) {
					console.log('No credential created. The existing secret cannot be read back.');
					return;
				}
			}
			issued = await mintCredential(session, serviceId);
		} finally {
			await logout(session);
		}

		const entries = {
			COMMERCE_API_URL: baseUrl,
			COMMERCE_SERVICE_ID: issued.serviceId ?? serviceId,
			COMMERCE_SERVICE_CREDENTIAL: issued.secret
		};
		console.log(`Created credential ${issued.credentialId}.`);

		if (options.print) {
			console.log('\nSet these in the deployment (the secret is shown only now):\n');
			printVariables(entries);
		} else {
			try {
				await writeFile(envFile, upsertEnv(envText, entries), { encoding: 'utf8', mode: 0o600 });
				console.log(
					`\nWrote COMMERCE_API_URL, COMMERCE_SERVICE_ID and COMMERCE_SERVICE_CREDENTIAL to ${path.relative(repoRoot, envFile)}.`
				);
			} catch (error) {
				console.error(`\nCould not write ${envFile}: ${error.message}`);
				console.error('The secret is shown only once; copy it now:\n');
				printVariables(entries);
				process.exitCode = 1;
				return;
			}
		}

		console.log('\nNext: set BOOKING_ENABLED=true, then (re)start the public site: npm run dev');
		if (previous.length > 0) {
			console.log(
				`Rotating? After verifying /book, revoke the old credential${previous.length === 1 ? '' : 's'}: ` +
					`DELETE /admin/access/services/${entries.COMMERCE_SERVICE_ID}/credentials/{credentialId} ` +
					`(${previous.join(', ')}).`
			);
		}
	} finally {
		prompter.close();
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		if (error instanceof ProvisionError) console.error(`\n${error.message}`);
		else if (error?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
			console.error(`\n${error.message}\n\n${USAGE}`);
		} else console.error(error);
		process.exitCode = 1;
	});
}
