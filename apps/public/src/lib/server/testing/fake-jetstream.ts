/**
 * Test-only JetStream double for the inquiry stream: stores by `Nats-Msg-Id` with the stream's
 * duplicate detection, and fails on request with the real nats.js error classes, so
 * `classifyPublishError` is exercised as in production.
 */
import { errors } from '@nats-io/transport-node';
import { JetStreamApiError } from '@nats-io/jetstream';
import { jserrors } from '@nats-io/jetstream/internal';
import { NatsUnavailableError, type JetStreamPublish, type PublishOptions } from '../nats.js';
import type { InquirySubmittedEvent } from '../inquiry-event.js';

/** A one-off answer to the next publish, overriding the stream's normal behavior. */
export type Scripted =
	/** Not connected (unconfigured, unreachable or closed): nothing sent. */
	| 'unavailable'
	/** No acknowledgement in time; the stream never got the message. */
	| 'timeout'
	/** The stream stores the message, then its acknowledgement is lost. */
	| 'store-then-timeout'
	/** No stream captures the subject ("no responders"). */
	| 'no-stream'
	/** The server refuses this user's publish. */
	| 'forbidden'
	/** The subject is captured by a different stream than the one expected. */
	| 'wrong-stream';

export type Delivery = {
	subject: string;
	msgID: string;
	streamName: string;
	headers: Record<string, string>;
	/** The exact bytes published. */
	bytes: string;
	event: InquirySubmittedEvent;
};

export function fakeJetStream() {
	/** Every publish attempt, in order, whatever happened to it. */
	const deliveries: Delivery[] = [];
	/** What the stream stored: one message per msg ID. */
	const stored: Delivery[] = [];
	const seqByMsgId = new Map<string, number>();
	const scripted: Scripted[] = [];

	function store(delivery: Delivery) {
		const seq = seqByMsgId.get(delivery.msgID);
		if (seq !== undefined) return { seq, duplicate: true };
		stored.push(delivery);
		seqByMsgId.set(delivery.msgID, stored.length);
		return { seq: stored.length, duplicate: false };
	}

	const publish: JetStreamPublish = async (subject, payload, options: PublishOptions) => {
		const bytes = new TextDecoder().decode(payload);
		const delivery: Delivery = {
			subject,
			msgID: options.msgID,
			streamName: options.streamName,
			headers: { ...options.headers },
			bytes,
			event: JSON.parse(bytes) as InquirySubmittedEvent
		};
		deliveries.push(delivery);
		switch (scripted.shift()) {
			case 'unavailable':
				throw new NatsUnavailableError('NATS connection failed');
			case 'timeout':
				throw new errors.TimeoutError();
			case 'store-then-timeout':
				store(delivery);
				throw new errors.TimeoutError();
			case 'no-stream':
				throw new jserrors.JetStreamNotEnabled('jetstream is not enabled');
			case 'forbidden': {
				// As nats.js reports a denied request: the violation is the RequestError's cause.
				const message = `Permissions Violation for Publish to "${subject}"`;
				throw new errors.RequestError(message, {
					cause: new errors.PermissionViolationError(message, 'publish', subject)
				});
			}
			case 'wrong-stream':
				throw new JetStreamApiError({
					code: 400,
					err_code: 10060,
					description: 'expected stream does not match'
				});
		}
		return { stream: options.streamName, ...store(delivery) };
	};

	return {
		publish,
		deliveries,
		stored,
		/** Queue one-off answers for the next publishes. */
		script: (...next: Scripted[]) => scripted.push(...next)
	};
}

export type FakeJetStream = ReturnType<typeof fakeJetStream>;
