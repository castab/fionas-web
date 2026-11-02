import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeTimeline } from './timeline-updates.js';
import { mayaId } from '../../../e2e/request-fixture.mjs';

const cookie = '__Host-fionas_session="actual-staff"';
const encoder = new TextEncoder();
const decode = (value?: Uint8Array) => new TextDecoder().decode(value);
function setup(response: Response | Error) {
	const fetch = vi.fn<typeof globalThis.fetch>();
	if (response instanceof Error) fetch.mockRejectedValue(response);
	else fetch.mockResolvedValue(response);
	const config = { baseUrl: 'https://private.test/', origin: 'https://admin.test', fetch };
	const browser = new AbortController();
	return {
		fetch,
		browser,
		response: () => subscribeTimeline(config, mayaId, cookie, browser.signal)
	};
}
async function expectPlaceholder(response: Response) {
	expect(response.status).toBe(200);
	expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
	expect(response.headers.get('cache-control')).toBe('no-store, no-transform');
	expect(await response.text()).toMatch(/^retry: (?:[56]\d{3}|7000)\n\n$/);
}
afterEach(() => vi.useRealTimers());
describe('native streaming BFF transport', () => {
	it('forwards exact delayed frames without buffering, with only trusted headers', async () => {
		let writer!: ReadableStreamDefaultController<Uint8Array>;
		const cancelled = vi.fn();
		const upstream = new ReadableStream<Uint8Array>({
			start(c) {
				writer = c;
			},
			cancel: cancelled
		});
		const test = setup(
			new Response(upstream, {
				headers: {
					'content-type': 'text/event-stream',
					'set-cookie': 'private',
					'x-private': 'secret'
				}
			})
		);
		const response = await test.response();
		expect(test.fetch.mock.calls[0][0]).toBe(
			`https://private.test/staff/requests/${mayaId}/updates`
		);
		const options = test.fetch.mock.calls[0][1]!;
		expect(options).toMatchObject({
			redirect: 'manual',
			method: 'GET',
			headers: {
				cookie,
				origin: 'https://admin.test',
				accept: 'text/event-stream',
				'accept-encoding': 'identity'
			}
		});
		expect(Object.keys(options.headers!)).toHaveLength(4);
		expect(response.headers.get('cache-control')).toBe('no-store, no-transform');
		expect(response.headers.get('x-accel-buffering')).toBe('no');
		expect(response.headers.has('set-cookie')).toBe(false);
		expect(response.headers.has('x-private')).toBe(false);
		const reader = response.body!.getReader();
		expect(decode((await reader.read()).value)).toMatch(/^retry: [567]\d{3}\n\n$/);
		const frame =
			': keepalive\n\nretry:3000\n\nevent:timeline.changed\nid:0\ndata:{"revision":"0"}\n\n';
		writer.enqueue(encoder.encode(frame));
		expect(decode((await reader.read()).value)).toBe(frame);
		writer.enqueue(encoder.encode('data:delayed\n\n'));
		expect(decode((await reader.read()).value)).toBe('data:delayed\n\n');
		await reader.cancel();
		expect(cancelled).toHaveBeenCalledOnce();
		expect(options.signal!.aborted).toBe(true);
	});
	it('keeps the body alive past handshake deadline and propagates browser abort', async () => {
		vi.useFakeTimers();
		const test = setup(
			new Response(new ReadableStream(), {
				headers: { 'content-type': 'text/event-stream; charset=utf-8' }
			})
		);
		const response = await test.response();
		await vi.advanceTimersByTimeAsync(70_000);
		const signal = test.fetch.mock.calls[0][1]!.signal!;
		expect(signal.aborted).toBe(false);
		test.browser.abort();
		expect(signal.aborted).toBe(true);
		await response.body!.cancel();
	});
	it('bounds the handshake and retries a connection timeout without diagnostics', async () => {
		vi.useFakeTimers();
		const fetch = vi.fn<typeof globalThis.fetch>(
			(_, options) =>
				new Promise((_, reject) => {
					options!.signal!.addEventListener('abort', () => reject(new Error('private')));
				})
		);
		const result = subscribeTimeline(
			{ baseUrl: 'https://private.test', origin: 'https://admin.test', fetch },
			mayaId,
			cookie,
			new AbortController().signal
		);
		await vi.advanceTimersByTimeAsync(8000);
		const response = await result;
		expect(response.status).toBe(200);
		expect(await response.text()).toMatch(/^retry: [567]\d{3}\n\n$/);
	});
	it.each([401, 403, 404, 400, 500, 502, 302])(
		'terminates status %s without forwarding JSON/redirects',
		async (status) => {
			const response = await setup(
				Response.json({ message: 'PRIVATE' }, { status, headers: { location: '/login' } })
			).response();
			expect(response.status).toBe(204);
			expect(await response.text()).toBe('');
			expect(response.headers.has('location')).toBe(false);
		}
	);
	it.each([
		new Response('PRIVATE', { headers: { 'content-type': 'text/html' } }),
		new Response(null, { headers: { 'content-type': 'text/event-stream' } }),
		Response.json({ code: 'timeline_updates_unavailable', message: 'PRIVATE' }, { status: 503 })
	])('fails closed for malformed streams and disabled capability', async (upstream) => {
		const response = await setup(upstream).response();
		expect(response.status).toBe(204);
		expect(await response.text()).toBe('');
	});
	it.each([
		new Error('private network detail'),
		new Response(null, { status: 503 }),
		new Response('<html>PRIVATE gateway outage</html>', {
			status: 503,
			headers: { 'content-type': 'text/html' }
		}),
		new Response('PRIVATE outage: timeline_updates_unavailable', { status: 503 }),
		new Response('{"code":', { status: 503, headers: { 'content-type': 'application/json' } }),
		Response.json({ message: 'PRIVATE' }, { status: 503 }),
		Response.json(null, { status: 503 }),
		Response.json({ code: 'unavailable', message: 'PRIVATE' }, { status: 503 })
	])('retries only temporary failures with no event', async (upstream) => {
		const response = await setup(upstream).response();
		await expectPlaceholder(response);
	});
	it.each(['oversize', 'timeout', 'disconnect'] as const)(
		'releases the diagnostic reader on %s',
		async (cause) => {
			vi.useFakeTimers();
			let reading!: () => void;
			const started = new Promise<void>((resolve) => {
				reading = resolve;
			});
			const cancel = vi.fn();
			const body = new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						reading();
						if (cause === 'oversize') controller.enqueue(encoder.encode('é'.repeat(4097)));
					},
					cancel
				},
				{ highWaterMark: 0 }
			);
			const test = setup(new Response(body, { status: 503 }));
			const result = test.response();
			await started;
			if (cause === 'disconnect') test.browser.abort();
			if (cause === 'timeout') await vi.advanceTimersByTimeAsync(8000);
			const response = await result;
			if (cause === 'disconnect') {
				expect(response.status).toBe(204);
				expect(await response.text()).toBe('');
			} else await expectPlaceholder(response);
			expect(cancel).toHaveBeenCalledOnce();
			expect(test.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		}
	);
	it('missing credentials and malformed identifiers never reach commerce', async () => {
		const fetch = vi.fn();
		const config = { baseUrl: 'https://private.test', origin: 'https://admin.test', fetch };
		for (const [id, credential] of [
			[mayaId, null],
			['../bad', cookie]
		]) {
			expect(
				(await subscribeTimeline(config, id!, credential, new AbortController().signal)).status
			).toBe(204);
		}
		expect(fetch).not.toHaveBeenCalled();
	});
	it('ends an established failing stream cleanly', async () => {
		let writer!: ReadableStreamDefaultController<Uint8Array>;
		const test = setup(
			new Response(
				new ReadableStream({
					start(c) {
						writer = c;
					}
				}),
				{ headers: { 'content-type': 'text/event-stream' } }
			)
		);
		const reader = (await test.response()).body!.getReader();
		await reader.read();
		writer.error(new Error('PRIVATE'));
		expect((await reader.read()).done).toBe(true);
		expect(test.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
	});
});
