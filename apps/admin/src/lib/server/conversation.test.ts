import { describe, expect, it, vi } from 'vitest';
import {
	acknowledgeInquiryCommunication,
	getStaffTimeline,
	sendStaffConversationReply
} from './conversation.js';
import { request } from './backend.js';
import { conversationFixture } from '../../../e2e/conversation-fixture.mjs';
import { mayaId } from '../../../e2e/request-fixture.mjs';

const config = (fetch: typeof globalThis.fetch) => ({
	baseUrl: 'https://commerce.test',
	origin: 'https://admin.test',
	fetch
});
describe('conversation transport', () => {
	it('reads once with the staff cookie and trusted Origin', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(Response.json(conversationFixture()));
		expect((await getStaffTimeline(config(fetch), mayaId, 'session=staff')).ok).toBe(true);
		expect(fetch).toHaveBeenCalledExactlyOnceWith(
			`https://commerce.test/staff/requests/${mayaId}/timeline`,
			expect.objectContaining({
				method: 'GET',
				headers: expect.objectContaining({ cookie: 'session=staff', origin: 'https://admin.test' }),
				redirect: 'manual'
			})
		);
	});
	it.each([200, 201, 202])(
		'classifies HTTP %s without inventing a timeline message',
		async (status) => {
			const data =
				status === 202
					? { outcome: 'UNKNOWN', replayed: false }
					: {
							outcome: 'ACCEPTED',
							replayed: status === 200,
							messageId: 'message',
							conversationId: 'conversation',
							sendState: 'pending'
						};
			const fetch = vi
				.fn<typeof globalThis.fetch>()
				.mockResolvedValue(Response.json(data, { status }));
			const body = { body: 'Hi\nMaya', expectEmptyConversation: true as const };
			const result = await sendStaffConversationReply(
				config(fetch),
				mayaId,
				'same-key',
				body,
				'session=staff'
			);
			expect(result).toMatchObject({ ok: true, data, status });
			expect(fetch).toHaveBeenCalledOnce();
			expect(fetch.mock.calls[0][1]).toMatchObject({
				method: 'POST',
				body: JSON.stringify(body),
				headers: {
					'idempotency-key': 'same-key',
					cookie: 'session=staff',
					origin: 'https://admin.test'
				}
			});
		}
	);
	it('never retries a timeout and grants only the reply its bounded timeout', async () => {
		const spy = vi.spyOn(AbortSignal, 'timeout');
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockRejectedValue(new DOMException('PRIVATE', 'TimeoutError'));
		const result = await sendStaffConversationReply(
			config(fetch),
			mayaId,
			'key',
			{ body: 'Hi', expectedLatestMessageId: 'message' },
			'session=staff'
		);
		expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } });
		expect(fetch).toHaveBeenCalledOnce();
		expect(spy).toHaveBeenLastCalledWith(100000);
		await getStaffTimeline(config(fetch), mayaId, null);
		expect(spy).toHaveBeenLastCalledWith(8000);
		spy.mockRestore();
	});
	it('refuses unsafe header values and routes before fetch', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		await expect(
			sendStaffConversationReply(
				config(fetch),
				mayaId,
				'x\r\nCookie: bad',
				{ body: 'Hi', expectEmptyConversation: true },
				null
			)
		).rejects.toThrow();
		await expect(
			request(config(fetch), '/auth/me', { idempotencyKey: 'key', conversationReply: true })
		).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});
	it('posts precisely the observed acknowledgement watermark once', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(new Response(null, { status: 204 }));
		expect(
			await acknowledgeInquiryCommunication(config(fetch), mayaId, 12, 'session=staff')
		).toMatchObject({ ok: true, status: 204 });
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0][1]?.body).toBe('{"throughRecordedOrder":12}');
	});
	it('isolates malformed reads and treats malformed successes as uncertain sends', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementation(async () => Response.json({ text: 'PRIVATE' }));
		expect(await getStaffTimeline(config(fetch), mayaId, null)).toMatchObject({ ok: false });
		expect(
			await sendStaffConversationReply(
				config(fetch),
				mayaId,
				'key',
				{ body: 'Hi', expectEmptyConversation: true },
				null
			)
		).toMatchObject({ ok: false, error: { code: 'uncertain_send' } });
		expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE');
		log.mockRestore();
	});
});
