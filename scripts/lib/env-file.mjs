// Reading and writing the dotenv file that holds the public site's service credential.

import { chmod, readFile, stat, writeFile } from 'node:fs/promises';

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

export async function readEnvFile(file) {
	try {
		return await readFile(file, 'utf8');
	} catch (error) {
		if (error.code === 'ENOENT') return '';
		throw error;
	}
}

const defaultFs = { writeFile, chmod, stat };

/**
 * Writes a dotenv file that contains a secret, then makes it readable and writable by its owner
 * only. `writeFile`'s `mode` applies only when the file is created, and the usual setup copies
 * `.env.example` first (often group/world-readable), so the mode is set explicitly afterwards and
 * read back. Throws only if the write itself fails (the caller still holds the secret then).
 *
 * Returns how the permissions ended up:
 * - `owner-only`: mode 0600 confirmed
 * - `unsupported`: Windows, where POSIX modes don't apply (access comes from the folder's ACL)
 * - `failed` with a `reason` (an error code, never file contents): chmod failed, or the file
 *   system ignored it, so the file may still be readable by others
 */
export async function writeSecretEnvFile(
	file,
	text,
	{ platform = process.platform, fs = defaultFs } = {}
) {
	await fs.writeFile(file, text, { encoding: 'utf8', mode: 0o600 });
	if (platform === 'win32') return { permissions: 'unsupported' };
	try {
		await fs.chmod(file, 0o600);
		const { mode } = await fs.stat(file);
		// Some mounts (network shares, Windows drives under WSL) accept chmod and change nothing.
		if ((mode & 0o077) !== 0) return { permissions: 'failed', reason: 'mode-not-applied' };
	} catch (error) {
		return { permissions: 'failed', reason: String(error?.code ?? 'unknown') };
	}
	return { permissions: 'owner-only' };
}

/** What to tell the operator about the file's permissions; null when there is nothing to add. */
export function permissionNotice(result, displayPath) {
	switch (result.permissions) {
		case 'owner-only':
			return null;
		case 'unsupported':
			return (
				`Note: ${displayPath} holds a secret. On Windows its access comes from the folder's ` +
				'permissions, so keep the repository in a folder only your account can read.'
			);
		default:
			return (
				`Warning: could not make ${displayPath} readable by its owner only (${result.reason}). ` +
				`It holds a secret and may be readable by other users: run \`chmod 600 ${displayPath}\` ` +
				'or move it somewhere private.'
			);
	}
}

export const NEXT_STEP =
	'Next: set BOOKING_ENABLED=true, then (re)start the public site: npm run dev';

/**
 * What to tell the operator once the credential is in the env file, and whether provisioning ends
 * normally. A file that may be readable by other users is not a finished setup: the warning, a
 * non-zero exit and no "enable booking" next step. The file is kept (its secret can't be read back
 * from the backend). Windows (`unsupported`) ends normally, with its note.
 */
export function envFileReport(result, displayPath) {
	const notice = permissionNotice(result, displayPath);
	if (result.permissions === 'failed') {
		return {
			exitCode: 1,
			out: [],
			err: [
				notice,
				`The credential was written, but fix the permissions of ${displayPath} before enabling booking.`
			]
		};
	}
	return {
		exitCode: 0,
		out: [notice ?? `${displayPath} is readable and writable by its owner only (0600).`, NEXT_STEP],
		err: []
	};
}
