import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { connectionSettings, LOCAL_SERVER } from './nats-connect.mjs';

/** A terminal question. Secret input (including paste) is never echoed or saved. */
export function askTerminal(
	prompt,
	{ secret = false, input = process.stdin, output: terminalOutput = process.stdout } = {}
) {
	return new Promise((resolve, reject) => {
		const output = new Writable({
			write(chunk, encoding, callback) {
				if (!secret) terminalOutput.write(chunk, encoding);
				callback();
			}
		});
		const rl = createInterface({ input, output, terminal: true, historySize: 0 });
		let answered = false;
		if (secret) terminalOutput.write(prompt);
		rl.on('SIGINT', () => rl.close());
		rl.on('close', () => {
			output.end();
			if (secret) terminalOutput.write('\n');
			if (!answered) reject(new Error('Setup cancelled. Nothing was changed.'));
		});
		rl.question(secret ? '' : prompt, (answer) => {
			answered = true;
			rl.close();
			resolve(answer);
		});
	});
}

/** Non-token authentication: a .creds file, else a username and hidden password, else none. */
async function promptOtherAuth(result, ask) {
	// Windows "Copy as path" wraps the path in quotes.
	const creds = (await ask('Path to a .creds file [Enter to skip]: '))
		.trim()
		.replace(/^"(.*)"$/, '$1');
	if (creds) return { ...result, creds };
	const user = (await ask('NATS username [Enter to connect without authentication]: ')).trim();
	if (!user) return result;
	const password = await ask('NATS password: ', { secret: true });
	return { ...result, user, password };
}

/**
 * Fill missing connection options interactively; flags/env remain usable without a terminal.
 * With `otherAuth`, an empty token on a remote target falls through to a .creds file, then a
 * username/password, instead of insisting on a token.
 */
export async function promptSetupConnection(
	values,
	{
		env = process.env,
		interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
		ask = askTerminal,
		otherAuth = false
	} = {}
) {
	if (values['non-interactive'] || !interactive) return values;
	const result = { ...values };
	if (result.server === undefined) {
		const defaultTarget = env.NATS_ADMIN_URL ?? LOCAL_SERVER;
		const label = env.NATS_ADMIN_URL ? 'configured NATS_ADMIN_URL' : 'local Docker';
		result.server =
			(await ask(`NATS target URL(s), comma-separated [${label}]: `)).trim() || defaultTarget;
	}
	const settings = connectionSettings(result, env);
	// Explicit flags or env credentials don't need to be re-entered.
	const authSupplied =
		['creds', 'token', 'user', 'password'].some((key) => result[key] !== undefined) ||
		Boolean(
			env.NATS_ADMIN_CREDS || env.NATS_ADMIN_TOKEN || env.NATS_ADMIN_USER || env.NATS_ADMIN_PASSWORD
		);
	if (authSupplied) return result;
	const local = settings.servers.length === 1 && settings.servers[0] === LOCAL_SERVER;
	while (true) {
		const tokenPrompt = local
			? 'NATS token [Enter for local Docker credentials]: '
			: otherAuth
				? 'NATS preshared token [Enter to use a .creds file or username/password]: '
				: 'NATS preshared token: ';
		const token = await ask(tokenPrompt, { secret: true });
		if (token) return { ...result, token };
		if (local) return result;
		if (otherAuth) return promptOtherAuth(result, ask);
		process.stdout.write(
			'A token is required for this target; use flags/env for other authentication.\n'
		);
	}
}
