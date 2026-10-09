import { errors } from '@nats-io/transport-node';
import { JetStreamApiError } from '@nats-io/jetstream';
import {
	INQUIRY_HEADERS,
	INQUIRY_STREAM,
	INQUIRY_SUBMITTED_SUBJECT,
	type InquirySubmittedEvent
} from './inquiry-event.js';
import { NatsUnavailableError, publishToJetStream, type JetStreamPublish } from './nats.js';

/*
 * Publishes InquirySubmitted events to NATS JetStream. See docs/public-inquiry-submission.md.
 *
 * Every delivery of one logical submission carries its key as `Nats-Msg-Id`, and the stream drops
 * a repeated ID inside its 24-hour duplicate window. So a delivery whose outcome is unknown is
 * only ever repeated identically, under the same key: if the first one was stored, the repeat is
 * acknowledged as a duplicate rather than stored twice.
 */

/**
 * - `unavailable`: definitely not stored. NATS isn't configured or reachable, the connection is
 *   closed, no stream captures the subject, this user may not publish it, or the stream refused the
 *   message. An operator problem: visitors see "unavailable", never why.
 * - `unknown`: the message may have been stored (no acknowledgement in time, the connection dropped
 *   after sending, or anything unexpected).
 * - `key_reused`: the very first delivery of a new command was acknowledged as a duplicate, so this
 *   key already belongs to an earlier, different submission. Nothing new was stored.
 */
export type PublishFailure = 'unavailable' | 'unknown' | 'key_reused';

export type PublishResult =
	{ ok: true; duplicate: boolean } | { ok: false; outcome: PublishFailure };

const TIMEOUT_MS = 5000;
/** A delivery is tried at most this often, and only again after an unknown outcome. */
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 250;

/** The server's refusal of this user's publish; nats.js wraps it as a RequestError's `cause`. */
function permissionViolation(
	error: unknown
): InstanceType<typeof errors.PermissionViolationError> | null {
	for (let e = error, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++)
		if (e instanceof errors.PermissionViolationError) return e;
	return null;
}

/** Whether a failed publish proves nothing was stored (`unavailable`) or not (`unknown`). */
export function classifyPublishError(error: unknown): 'unavailable' | 'unknown' {
	if (
		error instanceof NatsUnavailableError ||
		// Refused before anything was sent.
		error instanceof errors.DrainingConnectionError ||
		error instanceof errors.InvalidSubjectError ||
		error instanceof errors.InvalidArgumentError ||
		// The server refused the publish for this user.
		permissionViolation(error) ||
		// The stream answered with an error (wrong stream, limits, …): it stored nothing.
		error instanceof JetStreamApiError ||
		// No stream captures the subject (JetStream answers "no responders").
		(error instanceof Error && error.name === 'JetStreamNotEnabled')
	)
		return 'unavailable';
	return 'unknown';
}

/** A short, credential-free description for the server log. */
function describe(error: unknown): string {
	if (error instanceof JetStreamApiError) return `${error.name} ${error.code}`;
	const denied = permissionViolation(error);
	if (denied) return `${denied.name} (${denied.operation} ${denied.subject})`;
	return error instanceof Error ? error.name : 'unknown error';
}

export type InquiryPublisherConfig = {
	/** Defaults to this process's JetStream connection. */
	publish?: JetStreamPublish;
	/** Pause before the one identical retry. */
	retryDelayMs?: number;
};

export function createInquiryPublisher(config: InquiryPublisherConfig = {}) {
	const publish = config.publish ?? publishToJetStream;
	const retryDelayMs = config.retryDelayMs ?? RETRY_DELAY_MS;

	/**
	 * Publishes `event` under the logical submission `key`. `fresh` says this is the first time
	 * this server sends this command. A replay of a signed envelope isn't fresh: it resends a
	 * command that an earlier delivery may already have stored, so a duplicate means success.
	 */
	async function publishInquiry(
		event: InquirySubmittedEvent,
		key: string,
		{ fresh }: { fresh: boolean }
	): Promise<PublishResult> {
		// Serialized once: a retry repeats exactly these bytes and headers.
		const payload = new TextEncoder().encode(JSON.stringify(event));
		const options = {
			msgID: key,
			headers: INQUIRY_HEADERS,
			streamName: INQUIRY_STREAM,
			timeoutMs: TIMEOUT_MS
		};
		for (let attempt = 1; ; attempt++) {
			try {
				const ack = await publish(INQUIRY_SUBMITTED_SUBJECT, payload, options);
				if (ack.duplicate && fresh && attempt === 1) {
					console.warn('[events] Inquiry key was already used; nothing new was stored');
					return { ok: false, outcome: 'key_reused' };
				}
				return { ok: true, duplicate: ack.duplicate };
			} catch (e) {
				if (classifyPublishError(e) === 'unavailable') {
					console.error(`[events] Inquiry not published: ${describe(e)}`);
					// A retry that never reached the stream settles nothing: the first outcome stays unknown.
					return { ok: false, outcome: attempt === 1 ? 'unavailable' : 'unknown' };
				}
				if (attempt >= MAX_ATTEMPTS) {
					console.error(
						`[events] Inquiry delivery unknown after ${attempt} attempts: ${describe(e)}`
					);
					return { ok: false, outcome: 'unknown' };
				}
				console.warn(
					`[events] Inquiry delivery attempt ${attempt} unknown (${describe(e)}); retrying with the same Nats-Msg-Id`
				);
				await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
			}
		}
	}

	return { publishInquiry };
}

export type InquiryPublisher = ReturnType<typeof createInquiryPublisher>;

const shared = createInquiryPublisher();

export const publishInquiry: InquiryPublisher['publishInquiry'] = (event, key, options) =>
	shared.publishInquiry(event, key, options);
