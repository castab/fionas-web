import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errors } from '@nats-io/transport-node';
import { JetStreamApiError } from '@nats-io/jetstream';
import { jserrors } from '@nats-io/jetstream/internal';
import type { InquirySubmittedEvent } from './inquiry-event.js';
import { fakeJetStream, type FakeJetStream } from './testing/fake-jetstream.js';

vi.mock('$env/dynamic/private', () => ({ env: {} }));
const { classifyPublishError, createInquiryPublisher } = await import('./event-bus.js');
const { NatsUnavailableError } = await import('./nats.js');

const event = {
	schemaVersion: 1,
	type: 'fionas.inquiry.submitted',
	id: '0f8b5a3e-6c2d-4f1a-9b7e-3d4c5b6a7e8f',
	occurredAt: '2026-10-09T18:22:03.123Z',
	source: 'fionas-web',
	data: {}
} as unknown as InquirySubmittedEvent;

let stream: FakeJetStream;
let publisher: ReturnType<typeof createInquiryPublisher>;
beforeEach(() => {
	stream = fakeJetStream();
	publisher = createInquiryPublisher({ publish: stream.publish, retryDelayMs: 0 });
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('classifyPublishError', () => {
	it.each([
		['not connected', new NatsUnavailableError('NATS connection failed')],
		['draining', new errors.DrainingConnectionError()],
		['a denied publish', new errors.PermissionViolationError('denied', 'publish', 'x')],
		[
			'a denied publish, as nats.js reports it',
			new errors.RequestError('denied', {
				cause: new errors.PermissionViolationError('denied', 'publish', 'x')
			})
		],
		['no stream', new jserrors.JetStreamNotEnabled('jetstream is not enabled')],
		[
			'stream refusal',
			new JetStreamApiError({ code: 400, err_code: 10060, description: 'wrong stream' })
		]
	])('%s proves nothing was stored', (_, error) => {
		expect(classifyPublishError(error)).toBe('unavailable');
	});

	it.each([
		['a timeout', new errors.TimeoutError()],
		['a closed connection mid-request', new errors.ClosedConnectionError()],
		['a request error', new errors.RequestError('lost')],
		['anything else', new Error('surprise')],
		['a non-error', 'boom']
	])('%s leaves the outcome unknown', (_, error) => {
		expect(classifyPublishError(error)).toBe('unknown');
	});
});

describe('publishInquiry', () => {
	it('publishes once, keyed by the submission, to the inquiry stream', async () => {
		expect(await publisher.publishInquiry(event, 'key-1', { fresh: true })).toEqual({
			ok: true,
			duplicate: false
		});
		expect(stream.deliveries).toHaveLength(1);
		expect(stream.deliveries[0]).toMatchObject({
			subject: 'fionas.inquiries.submitted.v1',
			msgID: 'key-1',
			streamName: 'FIONAS_INQUIRIES',
			bytes: JSON.stringify(event)
		});
	});

	it('retries an unknown outcome exactly once with identical bytes and key', async () => {
		stream.script('timeout', 'timeout');
		expect(await publisher.publishInquiry(event, 'key-1', { fresh: true })).toEqual({
			ok: false,
			outcome: 'unknown'
		});
		expect(stream.deliveries).toHaveLength(2);
		expect(stream.deliveries[1].bytes).toBe(stream.deliveries[0].bytes);
		expect(stream.deliveries[1].msgID).toBe('key-1');
	});

	it('treats the duplicate ack after a lost ack as success', async () => {
		stream.script('store-then-timeout');
		expect(await publisher.publishInquiry(event, 'key-1', { fresh: true })).toEqual({
			ok: true,
			duplicate: true
		});
		expect(stream.stored).toHaveLength(1);
	});

	it.each(['unavailable', 'no-stream', 'forbidden', 'wrong-stream'] as const)(
		'never retries %s',
		async (failure) => {
			stream.script(failure);
			expect(await publisher.publishInquiry(event, 'key-1', { fresh: true })).toEqual({
				ok: false,
				outcome: 'unavailable'
			});
			expect(stream.deliveries).toHaveLength(1);
		}
	);

	it('keeps an unknown first outcome when the retry cannot reach the stream', async () => {
		stream.script('store-then-timeout', 'unavailable');
		expect(await publisher.publishInquiry(event, 'key-1', { fresh: true })).toEqual({
			ok: false,
			outcome: 'unknown'
		});
	});

	it('refuses a fresh command whose key the stream already holds', async () => {
		await publisher.publishInquiry(event, 'key-1', { fresh: true });
		expect(await publisher.publishInquiry(event, 'key-1', { fresh: true })).toEqual({
			ok: false,
			outcome: 'key_reused'
		});
	});

	it('accepts a duplicate for a replay of an earlier delivery', async () => {
		await publisher.publishInquiry(event, 'key-1', { fresh: true });
		expect(await publisher.publishInquiry(event, 'key-1', { fresh: false })).toEqual({
			ok: true,
			duplicate: true
		});
		expect(stream.stored).toHaveLength(1);
	});

	it('logs no message content', async () => {
		stream.script('timeout', 'forbidden');
		await publisher.publishInquiry(event, 'secret-key', { fresh: true });
		const logged = [
			...vi.mocked(console.warn).mock.calls,
			...vi.mocked(console.error).mock.calls
		].join('\n');
		expect(logged).not.toContain('secret-key');
		expect(logged).not.toContain(event.id);
	});
});
