// Mint the credentials apps/public needs to talk to fionas-commerce as SERVICE:fionas-web.
//
// Asks for the backend URL and an administrator login, then uses that admin session to provision or
// validate a dedicated, least-privilege SERVICE:fionas-web (lib/provision.mjs): the service, its
// `fionas.web` role (exactly the inquiry-creation permission) and that one assignment. Ambiguous or broader
// existing state is refused, never repaired. Only then does it create a credential, and it writes
// COMMERCE_API_URL, COMMERCE_SERVICE_ID and COMMERCE_SERVICE_CREDENTIAL into apps/public/.env
// (owner-only on POSIX) or prints them.
//
// Operator tool, not part of either app: it signs in as a USER, only to provision. Safe to re-run
// (it looks before creating). It never revokes anything. See README, "Service authentication".

import path from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
	NEXT_STEP,
	envFileReport,
	parseEnv,
	readEnvFile,
	upsertEnv,
	writeSecretEnvFile
} from './lib/env-file.mjs';
import { ProvisionError, ROLE, SERVICE_NAME, provisionService } from './lib/provision.mjs';

const DEFAULT_URL = 'http://localhost:8080';
const TIMEOUT_MS = 10_000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultEnvFile = path.join(repoRoot, 'apps', 'public', '.env');

const USAGE = `Usage: npm run provision:service -- [options]

Provisions (or validates) a dedicated SERVICE:${SERVICE_NAME} holding only role ${ROLE.key} on the
commerce backend and issues a new credential for it, using an administrator login you enter. Stops,
creating no credential, if the existing service or role is ambiguous or grants more than that.

Options
  --url <url>         Backend URL (otherwise asked; default: COMMERCE_API_URL in the env file)
  --username <name>   Administrator username (otherwise asked)
  --origin <url>      Origin sent to the backend (default: the backend URL's origin). Must be a
                      trusted origin on the API
  --out <path>        Where to write the variables (default: apps/public/.env)
  --print             Print the variables instead of writing a file (for a host's secret store)
  --yes               Don't ask for confirmation (replace existing values, add another credential)
  -h, --help          Show this help`;

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

		const api = async (method, route, json) =>
			expectOk(session, await request(session, method, route, json), `${method} ${route}`);
		let result;
		try {
			result = await provisionService({ api, confirm: prompter.confirm, log: console.log });
		} finally {
			await logout(session);
		}
		const { serviceId, issued, previous } = result;
		if (!issued) {
			console.log('No credential created. The existing secret cannot be read back.');
			return;
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
			console.log(`\n${NEXT_STEP}`);
		} else {
			const displayPath = path.relative(repoRoot, envFile) || envFile;
			let written;
			try {
				written = await writeSecretEnvFile(envFile, upsertEnv(envText, entries));
				console.log(
					`\nWrote COMMERCE_API_URL, COMMERCE_SERVICE_ID and COMMERCE_SERVICE_CREDENTIAL to ${displayPath}.`
				);
			} catch (error) {
				console.error(`\nCould not write ${envFile}: ${error.message}`);
				console.error('The secret is shown only once; copy it now:\n');
				printVariables(entries);
				process.exitCode = 1;
				return;
			}
			// A file other users may read is not a finished setup: warn, fail, and stop before the
			// "enable booking" step. The file is kept: its secret can't be read back from the backend.
			const report = envFileReport(written, displayPath);
			for (const line of report.err) console.error(`\n${line}`);
			for (const line of report.out) console.log(`\n${line}`);
			if (report.exitCode !== 0) {
				process.exitCode = report.exitCode;
				return;
			}
		}
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
