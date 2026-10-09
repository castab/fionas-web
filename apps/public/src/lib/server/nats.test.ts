import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NatsConnection, Status } from '@nats-io/transport-node';

const state = vi.hoisted(() => ({ env: {} as Record<string, string> }));
vi.mock('$env/dynamic/private', () => ({ env: state.env }));
vi.mock('@nats-io/transport-node', async (importOriginal) => ({
	...(await importOriginal<typeof import('@nats-io/transport-node')>()),
	connect: vi.fn()
}));
const { connect } = await import('@nats-io/transport-node');
const { closeNats, isNatsReady, publishToJetStream, NatsUnavailableError } =
	await import('./nats.js');

/** A connection whose status events and closing the test drives. */
function fakeConnection() {
	const queue: Status[] = [];
	let wake: (() => void) | null = null;
	let ended = false;
	let closed = false;
	let resolveClosed!: (value: void | Error) => void;
	const closedPromise = new Promise<void | Error>((resolve) => (resolveClosed = resolve));
	const end = (error?: Error) => {
		closed = ended = true;
		wake?.();
		resolveClosed(error);
	};
	const nc = {
		status: () => ({
			async *[Symbol.asyncIterator]() {
				while (!ended) {
					while (queue.length) yield queue.shift()!;
					await new Promise<void>((resolve) => (wake = resolve));
				}
			}
		}),
		closed: () => closedPromise,
		isClosed: () => closed,
		isDraining: () => false,
		drain: async () => end()
	} as unknown as NatsConnection;
	return {
		nc,
		emit(status: Status) {
			queue.push(status);
			wake?.();
		},
		close: end
	};
}

const named = (name: string) => Object.assign(new Error('detail'), { name });
const logged = () =>
	[
		...vi.mocked(console.info).mock.calls,
		...vi.mocked(console.warn).mock.calls,
		...vi.mocked(console.error).mock.calls
	]
		.flat()
		.join('\n');

beforeEach(() => {
	for (const key of Object.keys(state.env)) delete state.env[key];
	Object.assign(state.env, {
		NATS_URL: 'nats://web:hunter2@nats.internal.test:4222',
		NATS_USER: 'fionas-web',
		NATS_PASSWORD: 'test-only-nats-password'
	});
	vi.mocked(connect).mockReset();
	vi.spyOn(console, 'info').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
	await closeNats();
	vi.restoreAllMocks();
});

describe('isNatsReady', () => {
	it('is not ready without NATS_URL, and says so once', async () => {
		delete state.env.NATS_URL;
		expect(await isNatsReady()).toBe(false);
		expect(await isNatsReady()).toBe(false);
		expect(connect).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledTimes(1);
		expect(logged()).toContain('NATS_URL is not set');
	});

	it('logs a failed connect once per outage and tries again on the next check', async () => {
		vi.mocked(connect).mockRejectedValue(named('ConnectionError'));
		expect(await isNatsReady()).toBe(false);
		expect(await isNatsReady()).toBe(false);
		expect(connect).toHaveBeenCalledTimes(2);
		expect(console.error).toHaveBeenCalledTimes(1);
		expect(logged()).toContain('Connection failed: ConnectionError');

		vi.mocked(connect).mockResolvedValue(fakeConnection().nc);
		expect(await isNatsReady()).toBe(true);
		expect(logged()).toContain('[nats] Connected');
	});

	it('reuses one connection and follows its disconnects and reconnects', async () => {
		const fake = fakeConnection();
		vi.mocked(connect).mockResolvedValue(fake.nc);
		expect(await isNatsReady()).toBe(true);

		fake.emit({ type: 'disconnect', server: 'nats.internal.test:4222' });
		await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
		expect(await isNatsReady()).toBe(false);
		expect(logged()).toContain('Disconnected; reconnecting');

		fake.emit({ type: 'reconnect', server: 'nats.internal.test:4222' });
		await vi.waitFor(() => expect(logged()).toContain('Reconnected'));
		expect(await isNatsReady()).toBe(true);
		expect(connect).toHaveBeenCalledTimes(1);
	});

	it('gives up waiting for a slow connect', async () => {
		vi.mocked(connect).mockReturnValue(new Promise(() => {}));
		const started = Date.now();
		expect(await isNatsReady(20)).toBe(false);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it('forgets a closed connection and connects again', async () => {
		const first = fakeConnection();
		vi.mocked(connect).mockResolvedValueOnce(first.nc);
		expect(await isNatsReady()).toBe(true);

		first.close(named('AuthorizationError'));
		await vi.waitFor(() => expect(logged()).toContain('Connection closed: AuthorizationError'));
		vi.mocked(connect).mockResolvedValueOnce(fakeConnection().nc);
		expect(await isNatsReady()).toBe(true);
		expect(connect).toHaveBeenCalledTimes(2);
	});

	it('closes quietly on shutdown', async () => {
		vi.mocked(connect).mockResolvedValue(fakeConnection().nc);
		expect(await isNatsReady()).toBe(true);
		await closeNats();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(console.warn).not.toHaveBeenCalled();
	});

	it("doesn't wait on shutdown for a connect in flight, and drains it when it lands", async () => {
		let land!: (nc: NatsConnection) => void;
		vi.mocked(connect).mockReturnValue(new Promise((resolve) => (land = resolve)));
		expect(await isNatsReady(10)).toBe(false);
		await closeNats();
		const late = fakeConnection();
		land(late.nc);
		await vi.waitFor(() => expect(late.nc.isClosed()).toBe(true));
		expect(logged()).not.toContain('Connected');
	});

	it('never logs server addresses or credentials', async () => {
		vi.mocked(connect).mockRejectedValueOnce(named('ConnectionError'));
		await isNatsReady();
		const fake = fakeConnection();
		vi.mocked(connect).mockResolvedValue(fake.nc);
		await isNatsReady();
		fake.emit({ type: 'disconnect', server: 'nats.internal.test:4222' });
		fake.emit({ type: 'ldm', server: 'nats.internal.test:4222' });
		fake.emit({ type: 'error', error: named('PermissionViolationError') });
		await vi.waitFor(() => expect(logged()).toContain('PermissionViolationError'));
		for (const secret of ['hunter2', 'nats.internal', 'fionas-web', 'test-only-nats-password'])
			expect(logged()).not.toContain(secret);
	});
});

describe('publishToJetStream', () => {
	it('reports a failed connect as NATS being unavailable', async () => {
		vi.mocked(connect).mockRejectedValue(named('ConnectionError'));
		await expect(
			publishToJetStream('subject', new Uint8Array(), {
				msgID: 'key',
				headers: {},
				streamName: 'STREAM',
				timeoutMs: 100
			})
		).rejects.toBeInstanceOf(NatsUnavailableError);
	});
});
