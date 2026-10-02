import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	parseEnv,
	permissionNotice,
	readEnvFile,
	upsertEnv,
	writeSecretEnvFile
} from './env-file.mjs';

/* Env file handling. Filesystem tests use a fresh temporary directory, never apps/public/.env. */

const SECRET = 'test-only-credential-value';
const posix = process.platform !== 'win32';

let dir;
beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'fionas-env-'));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('parseEnv / upsertEnv', () => {
	it('reads plain, quoted and exported values, later lines winning', () => {
		const values = parseEnv('A=1\nexport B="two words"\n# C=3\nA=4 # note\n');
		expect(Object.fromEntries(values)).toEqual({ A: '4', B: 'two words' });
	});

	it('replaces keys in place, appends new ones and keeps everything else', () => {
		const text = '# comment\r\nCOMMERCE_SERVICE_ID=old\r\nBOOKING_ENABLED=false\r\n';
		expect(
			upsertEnv(text, { COMMERCE_SERVICE_ID: 'new', COMMERCE_SERVICE_CREDENTIAL: 'a b' })
		).toBe(
			'# comment\r\nCOMMERCE_SERVICE_ID=new\r\nBOOKING_ENABLED=false\r\nCOMMERCE_SERVICE_CREDENTIAL="a b"\r\n'
		);
	});

	it('reads a missing file as empty', async () => {
		expect(await readEnvFile(path.join(dir, 'absent.env'))).toBe('');
	});
});

describe('writeSecretEnvFile', () => {
	it.skipIf(!posix)('creates a new file readable by its owner only', async () => {
		const file = path.join(dir, '.env');
		expect(await writeSecretEnvFile(file, `COMMERCE_SERVICE_CREDENTIAL=${SECRET}\n`)).toEqual({
			permissions: 'owner-only'
		});
		expect((await stat(file)).mode & 0o777).toBe(0o600);
	});

	it.skipIf(!posix)(
		'tightens an existing world-readable file (a copied .env.example)',
		async () => {
			const file = path.join(dir, '.env');
			await writeFile(file, 'BOOKING_ENABLED=false\n', { mode: 0o644 });
			const { chmod } = await import('node:fs/promises');
			await chmod(file, 0o644);

			const result = await writeSecretEnvFile(file, `COMMERCE_SERVICE_CREDENTIAL=${SECRET}\n`);

			expect(result).toEqual({ permissions: 'owner-only' });
			expect((await stat(file)).mode & 0o777).toBe(0o600);
			expect(await readFile(file, 'utf8')).toContain(SECRET);
		}
	);

	it('reports a chmod failure by error code only, never the contents', async () => {
		const fs = {
			writeFile: vi.fn(async () => {}),
			chmod: vi.fn(async () => {
				throw Object.assign(new Error(`EPERM touching ${SECRET}`), { code: 'EPERM' });
			}),
			stat: vi.fn()
		};
		const result = await writeSecretEnvFile('x/.env', `KEY=${SECRET}`, { platform: 'linux', fs });
		expect(result).toEqual({ permissions: 'failed', reason: 'EPERM' });
		const notice = permissionNotice(result, 'apps/public/.env');
		expect(notice).toMatch(
			/could not make apps\/public\/\.env readable by its owner only \(EPERM\)/
		);
		expect(notice).toMatch(/chmod 600/);
		expect(`${JSON.stringify(result)} ${notice}`).not.toContain(SECRET);
	});

	it('does not claim protection when the file system ignores chmod', async () => {
		const fs = {
			writeFile: vi.fn(async () => {}),
			chmod: vi.fn(async () => {}),
			stat: vi.fn(async () => ({ mode: 0o100777 }))
		};
		expect(await writeSecretEnvFile('x/.env', 'K=v', { platform: 'linux', fs })).toEqual({
			permissions: 'failed',
			reason: 'mode-not-applied'
		});
	});

	it('does not fail on Windows, where POSIX modes do not apply', async () => {
		const fs = { writeFile: vi.fn(async () => {}), chmod: vi.fn(), stat: vi.fn() };
		const result = await writeSecretEnvFile('x/.env', 'K=v', { platform: 'win32', fs });
		expect(result).toEqual({ permissions: 'unsupported' });
		expect(fs.chmod).not.toHaveBeenCalled();
		expect(permissionNotice(result, '.env')).toMatch(/On Windows/);
	});

	it('lets a failed write surface, so the caller can still show the secret once', async () => {
		const fs = {
			writeFile: vi.fn(async () => {
				throw Object.assign(new Error('read-only'), { code: 'EROFS' });
			}),
			chmod: vi.fn(),
			stat: vi.fn()
		};
		await expect(writeSecretEnvFile('x/.env', 'K=v', { platform: 'linux', fs })).rejects.toThrow(
			'read-only'
		);
		expect(fs.chmod).not.toHaveBeenCalled();
	});

	it('says nothing more once the file is owner-only', () => {
		expect(permissionNotice({ permissions: 'owner-only' }, '.env')).toBeNull();
	});
});
