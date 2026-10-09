import { readFileSync } from 'node:fs';
import { env } from '$env/dynamic/private';
import { connect, credsAuthenticator, headers, type NatsConnection } from '@nats-io/transport-node';
import { jetstream } from '@nats-io/jetstream';

/*
 * This process's NATS connection, the only place that reads the NATS settings from private env:
 *
 * - NATS_URL: one server URL, or several comma-separated for a cluster
 * - NATS_CREDS_FILE: a .creds file (decentralized JWT auth; preferred in production), or
 * - NATS_USER + NATS_PASSWORD
 *
 * The connection opens lazily when /book first loads or submits (so the marketing site starts
 * without NATS), reconnects on its own, is rebuilt if the settings change, and drains when
 * SvelteKit shuts down. Connection changes are logged as `[nats] …`. Server URLs, users,
 * credentials and the creds path are never logged or returned: NATS_URL may embed credentials.
 */

/** NATS couldn't be used at all (unconfigured, unreachable, closed or draining): nothing was sent. */
export class NatsUnavailableError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'NatsUnavailableError';
	}
}

export type PublishOptions = {
	/** JetStream's `Nats-Msg-Id`: a repeat inside the stream's duplicate window is not stored again. */
	msgID: string;
	headers: Readonly<Record<string, string>>;
	/** The stream that must capture the subject; anything else is a refusal, not a store. */
	streamName: string;
	timeoutMs: number;
};

export type PublishAck = { stream: string; seq: number; duplicate: boolean };

/** A JetStream publish that resolves with the stream's acknowledgement. */
export type JetStreamPublish = (
	subject: string,
	payload: Uint8Array,
	options: PublishOptions
) => Promise<PublishAck>;

const CONNECT_TIMEOUT_MS = 3000;

type Settings = { servers: string[]; creds?: string; user?: string; pass?: string };

function settingsFromEnv(): Settings | null {
	const servers = (env.NATS_URL ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	if (servers.length === 0) return null;
	const creds = env.NATS_CREDS_FILE?.trim();
	if (creds) return { servers, creds };
	return {
		servers,
		user: env.NATS_USER?.trim() || undefined,
		pass: env.NATS_PASSWORD || undefined
	};
}

async function open({ servers, creds, user, pass }: Settings): Promise<NatsConnection> {
	return connect({
		servers,
		name: 'fionas-web',
		timeout: CONNECT_TIMEOUT_MS,
		// Keep trying after a drop; a publish meanwhile times out and is reported as unknown.
		maxReconnectAttempts: -1,
		...(creds
			? { authenticator: credsAuthenticator(readFileSync(creds)) }
			: user
				? { user, pass }
				: {})
	});
}

type Entry = {
	key: string;
	connection: Promise<NatsConnection>;
	/** The connection, once connected. */
	nc?: NatsConnection;
	/** Open and not reconnecting: a publish now can be acknowledged. */
	connected: boolean;
	/** Closed deliberately (shutdown, settings change): not worth a warning. */
	closing: boolean;
};

let shared: Entry | null = null;

/*
 * Operator logs: connection changes, never per request. They name only what happened, never a
 * server address, user, credential or path. While NATS stays unreachable, the failure is logged
 * once, not on every page view or submission; it's logged again only after a success.
 */
let lastProblem: string | null = null;
function reportProblem(problem: string) {
	if (problem === lastProblem) return;
	lastProblem = problem;
	console.error(`[nats] ${problem}; /book submissions are unavailable`);
}

/** Logs the connection's life from here on, and keeps `entry.connected` current. */
function watch(entry: Entry, nc: NatsConnection) {
	entry.connected = true;
	lastProblem = null;
	console.info('[nats] Connected');
	void (async () => {
		for await (const status of nc.status()) {
			switch (status.type) {
				case 'disconnect':
					entry.connected = false;
					console.warn('[nats] Disconnected; reconnecting (submissions meanwhile are unconfirmed)');
					break;
				case 'reconnect':
					entry.connected = true;
					console.info('[nats] Reconnected');
					break;
				case 'staleConnection':
					console.warn('[nats] Connection stale; reconnecting');
					break;
				case 'ldm':
					console.warn('[nats] Server entering lame duck mode; moving to another server');
					break;
				case 'error':
					console.error(`[nats] Server error: ${status.error.name}`);
					break;
			}
		}
	})().catch(() => {});
	void nc.closed().then((error) => {
		entry.connected = false;
		if (shared === entry) shared = null;
		if (error) console.error(`[nats] Connection closed: ${error.name}`);
		else if (!entry.closing) console.warn('[nats] Connection closed');
	});
}

async function connection(): Promise<NatsConnection> {
	const settings = settingsFromEnv();
	if (!settings) {
		reportProblem('NATS_URL is not set');
		throw new NatsUnavailableError('NATS is not configured');
	}
	const key = JSON.stringify(settings);
	if (shared && shared.key !== key) {
		void closeNats();
	}
	if (!shared) {
		const entry: Entry = { key, connection: open(settings), connected: false, closing: false };
		shared = entry;
		entry.connection.then(
			(nc) => {
				entry.nc = nc;
				// Shut down (or replaced) while connecting: don't keep a connection nobody owns.
				if (entry.closing) void nc.drain().catch(() => {});
				else watch(entry, nc);
			},
			(e: unknown) => {
				// A failed connect is forgotten, so the next submission tries again.
				if (shared === entry) shared = null;
				reportProblem(`Connection failed: ${e instanceof Error ? e.name : 'unknown error'}`);
			}
		);
	}
	let nc: NatsConnection;
	try {
		nc = await shared.connection;
	} catch (e) {
		throw new NatsUnavailableError('NATS connection failed', { cause: e });
	}
	if (nc.isClosed() || nc.isDraining()) {
		shared = null;
		throw new NatsUnavailableError('NATS connection closed');
	}
	return nc;
}

/**
 * Whether a submission could be published right now: NATS is configured and this process holds a
 * connection that is open and not reconnecting. Connects if needed, which also warms the
 * connection for the submission that follows, but waits at most `waitMs`. The web user has no
 * JetStream API access, so a missing stream or permission still surfaces only on submission.
 */
export async function isNatsReady(waitMs = 1500): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const gaveUp = new Promise<false>((resolve) => (timer = setTimeout(resolve, waitMs, false)));
	const ready = connection().then(
		(nc) => shared?.connected === true && !nc.isClosed(),
		() => false
	);
	try {
		return await Promise.race([ready, gaveUp]);
	} finally {
		clearTimeout(timer);
	}
}

/** Publishes one message to JetStream on this process's connection. */
export const publishToJetStream: JetStreamPublish = async (subject, payload, options) => {
	const nc = await connection();
	const h = headers();
	for (const [name, value] of Object.entries(options.headers)) h.set(name, value);
	const ack = await jetstream(nc).publish(subject, payload, {
		msgID: options.msgID,
		headers: h,
		expect: { streamName: options.streamName },
		timeout: options.timeoutMs
	});
	return { stream: ack.stream, seq: ack.seq, duplicate: ack.duplicate };
};

/** Drains and forgets this process's connection (on shutdown, a settings change, or in tests). */
export async function closeNats(): Promise<void> {
	const entry = shared;
	shared = null;
	lastProblem = null;
	if (!entry) return;
	entry.closing = true;
	// A connect still in flight isn't waited for: it drains itself when it lands (see `connection`).
	const nc = entry.nc;
	if (nc && !nc.isClosed()) await nc.drain().catch(() => {});
}

// adapter-node emits this on SIGINT/SIGTERM once in-flight requests have finished.
const SHUTDOWN_HOOK = Symbol.for('fionas.nats.shutdown');
const hooks = globalThis as { [SHUTDOWN_HOOK]?: true };
if (!hooks[SHUTDOWN_HOOK]) {
	hooks[SHUTDOWN_HOOK] = true;
	process.on('sveltekit:shutdown', () => void closeNats());
}
