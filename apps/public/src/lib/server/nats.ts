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
 * The connection opens lazily on the first submission (so the marketing site starts without
 * NATS), reconnects on its own, is rebuilt if the settings change, and drains when SvelteKit
 * shuts down. Server URLs, users, credentials and the creds path are never logged or returned:
 * NATS_URL may embed credentials.
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

let shared: { key: string; connection: Promise<NatsConnection> } | null = null;

async function connection(): Promise<NatsConnection> {
	const settings = settingsFromEnv();
	if (!settings) throw new NatsUnavailableError('NATS is not configured');
	const key = JSON.stringify(settings);
	if (shared && shared.key !== key) {
		void closeNats();
	}
	if (!shared) {
		const entry = { key, connection: open(settings) };
		shared = entry;
		// A failed connect is forgotten, so the next submission tries again.
		entry.connection.catch(() => {
			if (shared === entry) shared = null;
		});
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
	if (!entry) return;
	try {
		const nc = await entry.connection;
		if (!nc.isClosed()) await nc.drain();
	} catch {
		/* never connected, or already gone */
	}
}

// adapter-node emits this on SIGINT/SIGTERM once in-flight requests have finished.
const SHUTDOWN_HOOK = Symbol.for('fionas.nats.shutdown');
const hooks = globalThis as { [SHUTDOWN_HOOK]?: true };
if (!hooks[SHUTDOWN_HOOK]) {
	hooks[SHUTDOWN_HOOK] = true;
	process.on('sveltekit:shutdown', () => void closeNats());
}
