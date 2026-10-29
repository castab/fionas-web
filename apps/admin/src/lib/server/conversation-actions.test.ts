import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	acknowledgeConversation,
	loadConversation,
	sendConversationReply
} from './conversation-actions.js';
import {
	acknowledgeInquiryCommunication,
	getStaffTimeline,
	sendStaffConversationReply
} from './conversation.js';
import { createIntent, findIntent, REPLY_TTL_MS } from './reply-intents.js';
import { conversationFixture } from '../../../e2e/conversation-fixture.mjs';
import { mayaId } from '../../../e2e/request-fixture.mjs';

vi.mock('./conversation.js', () => ({
	acknowledgeInquiryCommunication: vi.fn(),
	getStaffTimeline: vi.fn(),
	sendStaffConversationReply: vi.fn()
}));
vi.mock('./config.js', () => ({
	backendConfig: () => ({ baseUrl: 'https://api.test', origin: 'https://admin.test' })
}));
vi.mock('./auth.js', () => ({ applySetCookies: vi.fn() }));
const permissions = [
	'fionas.communications.read',
	'fionas.communications.send',
	'fionas.communications.acknowledge'
];
function event(fields: Record<string, string> = {}, pointer?: string, grants = permissions) {
	return {
		params: { inquiryId: mayaId },
		locals: { user: { id: 'me', permissions: grants } },
		cookies: { get: () => pointer, set: vi.fn() },
		url: new URL(`https://admin.test/requests/${mayaId}?from=filter%3Dnew%26q%3DMaya`),
		request: new Request('https://admin.test', {
			method: 'POST',
			headers: { cookie: 'session=staff' },
			body: new URLSearchParams(fields)
		})
	} as unknown as Parameters<typeof sendConversationReply>[0];
}
const uncertain = () => ({
	ok: true as const,
	status: 202,
	data: { outcome: 'UNKNOWN' as const, replayed: false },
	setCookies: []
});
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getStaffTimeline).mockResolvedValue({
		ok: true,
		data: conversationFixture(),
		setCookies: []
	});
	vi.mocked(sendStaffConversationReply).mockResolvedValue(uncertain());
});
describe('immutable reply actions', () => {
	it('retains key, body and expectation through UNKNOWN, reload and new mail', async () => {
		const intent = createIntent('me', mayaId, { expectEmptyConversation: true })!;
		const first = await sendConversationReply(event({ key: intent.key, body: ' Hi\nMaya ' }));
		expect(first).toMatchObject({
			status: 409,
			data: { reply: { key: intent.key, body: 'Hi\nMaya', state: 'uncertain' } }
		});
		const reload = await loadConversation(event({}, intent.key));
		expect(reload.reply).toMatchObject({
			expectation: { expectEmptyConversation: true },
			body: 'Hi\nMaya'
		});
		await sendConversationReply(event({ key: intent.key, body: 'Hi\nMaya' }));
		expect(vi.mocked(sendStaffConversationReply).mock.calls[0]).toEqual(
			vi.mocked(sendStaffConversationReply).mock.calls[1]
		);
	});
	it('rejects altered reconciliation and refuses a new intent while uncertain', async () => {
		const intent = createIntent('me', mayaId, { expectEmptyConversation: true })!;
		await sendConversationReply(event({ key: intent.key, body: 'Original' }));
		expect(await sendConversationReply(event({ key: intent.key, body: 'Changed' }))).toMatchObject({
			status: 409
		});
		expect(
			await sendConversationReply(
				event({
					key: intent.key,
					body: 'Original',
					mode: 'review',
					expectEmptyConversation: 'true'
				})
			)
		).toMatchObject({ status: 409 });
		expect(sendStaffConversationReply).toHaveBeenCalledOnce();
	});
	it('locks concurrent clicks before awaiting the one backend mutation', async () => {
		const intent = createIntent('me', mayaId, { expectEmptyConversation: true })!;
		let release!: (value: ReturnType<typeof uncertain>) => void;
		vi.mocked(sendStaffConversationReply).mockReturnValue(
			new Promise((resolve) => {
				release = resolve;
			})
		);
		const first = sendConversationReply(event({ key: intent.key, body: 'Original' }));
		await vi.waitFor(() => expect(sendStaffConversationReply).toHaveBeenCalledOnce());
		expect(await sendConversationReply(event({ key: intent.key, body: 'Original' }))).toMatchObject(
			{ status: 409 }
		);
		release(uncertain());
		await first;
		expect(sendStaffConversationReply).toHaveBeenCalledOnce();
	});
	it('keeps transport failures uncertain and clears accepted bodies before PRG', async () => {
		const intent = createIntent('me', mayaId, { expectEmptyConversation: true })!;
		vi.mocked(sendStaffConversationReply).mockResolvedValueOnce({
			ok: false,
			retryAfter: null,
			error: { status: 503, code: 'unavailable', message: 'PRIVATE', violations: [] }
		});
		const failed = await sendConversationReply(event({ key: intent.key, body: 'Original' }));
		expect(failed).toMatchObject({ data: { reply: { state: 'uncertain' } } });
		expect(JSON.stringify(failed)).not.toContain('PRIVATE');
		vi.mocked(sendStaffConversationReply).mockResolvedValueOnce({
			ok: true,
			status: 200,
			data: { outcome: 'ACCEPTED', replayed: true },
			setCookies: []
		});
		await expect(
			sendConversationReply(event({ key: intent.key, body: 'Original' }))
		).rejects.toMatchObject({
			status: 303,
			location: expect.stringContaining('from=filter%3Dnew%26q%3DMaya')
		});
		expect(intent.body).toBe('');
		expect(intent.state).toBe('accepted');
		await expect(
			sendConversationReply(event({ key: intent.key, body: 'Original' }))
		).rejects.toMatchObject({ status: 303 });
		expect(
			await sendConversationReply(
				event({ key: intent.key, body: 'Different draft in another tab' })
			)
		).toMatchObject({ status: 409, data: { reply: { body: 'Different draft in another tab' } } });
		expect(sendStaffConversationReply).toHaveBeenCalledTimes(2);
	});
	it('requires explicit new-intent review after a definitive stale conflict', async () => {
		const intent = createIntent('me', mayaId, { expectEmptyConversation: true })!;
		vi.mocked(sendStaffConversationReply).mockResolvedValueOnce({
			ok: false,
			retryAfter: null,
			error: { status: 409, code: 'conversation_changed', message: 'PRIVATE', violations: [] }
		});
		await sendConversationReply(event({ key: intent.key, body: 'Original' }));
		expect(intent.state).toBe('rejected');
		const result = await sendConversationReply(
			event({
				key: intent.key,
				mode: 'review',
				expectedLatestMessageId: '71000000-0000-0000-0000-000000000001'
			})
		);
		expect(result).toMatchObject({ reply: { state: 'draft', body: 'Original' } });
		expect(sendStaffConversationReply).toHaveBeenCalledOnce();
	});
	it('refuses unauthorized, blank, oversized, expired and foreign intents without sending', async () => {
		const intent = createIntent('me', mayaId, { expectEmptyConversation: true })!;
		for (const body of [' ', 'a'.repeat(5001)])
			expect(await sendConversationReply(event({ key: intent.key, body }))).toMatchObject({
				status: 422
			});
		expect(
			await sendConversationReply(event({ key: intent.key, body: 'Hi' }, undefined, []))
		).toMatchObject({ status: 403 });
		expect(findIntent(intent.key, 'other-user', mayaId)).toBeNull();
		expect(findIntent(intent.key, 'me', 'other-inquiry')).toBeNull();
		intent.expires = Date.now() - REPLY_TTL_MS;
		expect((await loadConversation(event({}, intent.key))).recoveryLost).toBe(true);
		expect(await sendConversationReply(event({ key: intent.key, body: 'Hi' }))).toMatchObject({
			data: { recoveryLost: true }
		});
		expect(sendStaffConversationReply).not.toHaveBeenCalled();
	});
	it('uses only the observed watermark, with no pre-acknowledgement read', async () => {
		vi.mocked(acknowledgeInquiryCommunication).mockResolvedValue({
			ok: false,
			retryAfter: null,
			error: { status: 409, code: 'conversation_changed', message: 'PRIVATE', violations: [] }
		});
		expect(await acknowledgeConversation(event({ throughRecordedOrder: '12' }))).toMatchObject({
			status: 409
		});
		expect(acknowledgeInquiryCommunication).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			mayaId,
			12,
			'session=staff'
		);
		expect(getStaffTimeline).not.toHaveBeenCalled();
	});
});
