import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askTerminal, promptSetupConnection } from './nats-setup-prompt.mjs';
import { connectionSettings, LOCAL_SERVER } from './nats-connect.mjs';

const options = (ask) => ({ env: {}, interactive: true, ask });

describe('setup prompts', () => {
	it('uses Docker credentials when both answers are empty', async () => {
		const ask = vi.fn().mockResolvedValue('');
		const values = await promptSetupConnection({}, options(ask));
		expect(ask).toHaveBeenCalledTimes(2);
		expect(connectionSettings(values, {})).toEqual({
			servers: [LOCAL_SERVER],
			user: 'fionas-admin',
			pass: 'fionas-admin-dev'
		});
	});

	it('passes a remote token without adding local credentials', async () => {
		const ask = vi
			.fn()
			.mockResolvedValueOnce(' tls://dev.example:4222 ')
			.mockResolvedValueOnce('secret');
		const values = await promptSetupConnection({}, options(ask));
		expect(connectionSettings(values, {})).toEqual({
			servers: ['tls://dev.example:4222'],
			token: 'secret'
		});
		expect(ask.mock.calls[1][1]).toEqual({ secret: true });
	});

	it('uses the configured target default without printing it', async () => {
		const ask = vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce('secret');
		const env = { NATS_ADMIN_URL: 'tls://dev.example:4222' };
		const values = await promptSetupConnection({}, { ...options(ask), env });
		expect(values.server).toBe(env.NATS_ADMIN_URL);
		expect(ask.mock.calls[0][0]).not.toContain(env.NATS_ADMIN_URL);
	});

	it('asks again when a remote token is empty', async () => {
		const message = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		try {
			const ask = vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce('secret');
			const values = await promptSetupConnection(
				{ server: 'tls://dev.example:4222' },
				options(ask)
			);
			expect(values.token).toBe('secret');
			expect(ask).toHaveBeenCalledTimes(2);
		} finally {
			message.mockRestore();
		}
	});

	describe('with otherAuth (nats:tail)', () => {
		const remote = { server: 'tls://dev.example:4222' };
		const tail = (ask) => ({ ...options(ask), otherAuth: true });

		it('asks only for the token when one is given', async () => {
			const ask = vi.fn().mockResolvedValueOnce('secret');
			const values = await promptSetupConnection(remote, tail(ask));
			expect(values.token).toBe('secret');
			expect(ask).toHaveBeenCalledTimes(1);
		});

		it('falls back to a .creds file, tolerating quoted paths', async () => {
			const ask = vi
				.fn()
				.mockResolvedValueOnce('')
				.mockResolvedValueOnce(' "C:\\keys\\dev.creds" ');
			const values = await promptSetupConnection(remote, tail(ask));
			expect(connectionSettings(values, {})).toEqual({
				servers: [remote.server],
				creds: 'C:\\keys\\dev.creds'
			});
			expect(ask).toHaveBeenCalledTimes(2);
		});

		it('falls back to a username and hidden password', async () => {
			const ask = vi
				.fn()
				.mockResolvedValueOnce('')
				.mockResolvedValueOnce('')
				.mockResolvedValueOnce(' ops ')
				.mockResolvedValueOnce('hunter2');
			const values = await promptSetupConnection(remote, tail(ask));
			expect(connectionSettings(values, {})).toEqual({
				servers: [remote.server],
				user: 'ops',
				pass: 'hunter2'
			});
			expect(ask.mock.calls[3][1]).toEqual({ secret: true });
		});

		it('connects without authentication when every credential is skipped', async () => {
			const ask = vi.fn().mockResolvedValue('');
			expect(await promptSetupConnection(remote, tail(ask))).toEqual(remote);
			expect(ask).toHaveBeenCalledTimes(3);
		});

		it('still uses Docker credentials for the local target', async () => {
			const ask = vi.fn().mockResolvedValue('');
			const values = await promptSetupConnection({}, tail(ask));
			expect(ask).toHaveBeenCalledTimes(2);
			expect(connectionSettings(values, {}).user).toBe('fionas-admin');
		});
	});

	it('skips questions already answered by flags or env credentials', async () => {
		const ask = vi.fn();
		const values = { server: 'tls://dev.example:4222', token: 'flag-token' };
		expect(await promptSetupConnection(values, options(ask))).toEqual(values);
		await promptSetupConnection(
			{ server: values.server },
			{
				...options(ask),
				env: { NATS_ADMIN_TOKEN: 'env-token' }
			}
		);
		expect(ask).not.toHaveBeenCalled();
	});

	it.each([{ interactive: false }, { interactive: true, values: { 'non-interactive': true } }])(
		'does not prompt in automation: %j',
		async ({ interactive, values = {} }) => {
			const ask = vi.fn();
			expect(await promptSetupConnection(values, { ...options(ask), interactive })).toEqual(values);
			expect(ask).not.toHaveBeenCalled();
		}
	);

	it('propagates cancellation before connecting', async () => {
		const ask = vi.fn().mockRejectedValue(new Error('cancelled'));
		await expect(promptSetupConnection({}, options(ask))).rejects.toThrow('cancelled');
	});
});

describe('hidden terminal input', () => {
	beforeEach(() => vi.stubEnv('TERM', 'xterm'));
	afterEach(() => vi.unstubAllEnvs());

	it('does not echo pasted tokens and supports backspace', async () => {
		const input = new PassThrough();
		input.setRawMode = vi.fn();
		const output = new PassThrough();
		let displayed = '';
		output.on('data', (chunk) => {
			displayed += chunk.toString();
		});
		const answer = askTerminal('Token: ', { secret: true, input, output });
		input.write('secretX');
		input.write('\b');
		input.write('\r');
		expect(await answer).toBe('secret');
		expect(displayed).toBe('Token: \n');
		expect(input.setRawMode).toHaveBeenLastCalledWith(false);
	});

	it.each(['\x03', '\x04'])('cancels on interrupt/EOF %j', async (key) => {
		const input = new PassThrough();
		input.setRawMode = vi.fn();
		const output = new PassThrough();
		const answer = askTerminal('Token: ', { secret: true, input, output });
		input.write(key);
		await expect(answer).rejects.toThrow('Setup cancelled');
		expect(input.setRawMode).toHaveBeenLastCalledWith(false);
	});
});
