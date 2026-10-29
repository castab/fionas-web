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
import { createIntent, findIntent, REPLY_TTL_MS, resolveIntent } from './reply-intents.js';
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
	it('refuses unauthorized, blank, oversized and foreign intents without sending', async () => {
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
		expect(sendStaffConversationReply).not.toHaveBeenCalled();
	});
});
describe('expired reply intents', () => {
	const expire = (intent: { expires: number }) => {
		intent.expires = Date.now() - REPLY_TTL_MS;
	};
	it('replaces an untouched expired draft on load instead of blocking new sends', async () => {
		const stale = createIntent('me', mayaId, { expectEmptyConversation: true })!;
		expire(stale);
		const e = event({}, stale.key);
		const loaded = await loadConversation(e);
		expect(loaded.recoveryLost).toBe(false);
		expect(loaded.reply).toMatchObject({ state: 'draft', body: '' });
		expect(loaded.reply!.key).not.toBe(stale.key);
		expect(e.cookies.set).toHaveBeenCalledWith(
			'fionas_reply_intent',
			loaded.reply!.key,
			expect.objectContaining({ httpOnly: true, maxAge: 7 * 24 * 60 * 60 })
		);
	});
	it('keeps the text of a submission from an expired draft form but never sends it', async () => {
		const stale = createIntent('me', mayaId, { expectedLatestMessageId: 'm1' })!;
		expire(stale);
		const result = await sendConversationReply(event({ key: stale.key, body: 'Kept text' }));
		expect(result).toMatchObject({
			status: 409,
			data: {
				reply: {
					state: 'draft',
					body: 'Kept text',
					expectation: { expectedLatestMessageId: 'm1' }
				},
				conversationError: expect.stringContaining('Nothing was sent')
			}
		});
		const fresh = (result as { data: { reply: { key: string } } }).data.reply.key;
		expect(fresh).not.toBe(stale.key);
		expect(sendStaffConversationReply).not.toHaveBeenCalled();
		await sendConversationReply(event({ key: fresh, body: 'Kept text' }));
		expect(sendStaffConversationReply).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			mayaId,
			fresh,
			{ body: 'Kept text', expectedLatestMessageId: 'm1' },
			'session=staff'
		);
	});
	it('does not claim nothing was sent for an expired accepted form', async () => {
		const sent = createIntent('me', mayaId, { expectEmptyConversation: true })!;
		sent.state = 'accepted';
		expire(sent);
		expect(await sendConversationReply(event({ key: sent.key, body: 'Again?' }))).toMatchObject({
			data: { conversationError: expect.stringContaining('was not sent from it') }
		});
		expect(sendStaffConversationReply).not.toHaveBeenCalled();
	});
	it('fails closed when an attempted send expires unresolved', async () => {
		const intent = createIntent('me', mayaId, { expectEmptyConversation: true })!;
		await sendConversationReply(event({ key: intent.key, body: 'Maybe sent' }));
		expect(intent.state).toBe('uncertain');
		expire(intent);
		const e = event({}, intent.key);
		const loaded = await loadConversation(e);
		expect(loaded).toMatchObject({ recoveryLost: true, reply: null });
		expect(e.cookies.set).not.toHaveBeenCalled();
		expect(resolveIntent(intent.key, 'me', mayaId)).toEqual({ kind: 'lost' });
		expect(
			await sendConversationReply(event({ key: intent.key, body: 'Maybe sent' }))
		).toMatchObject({ status: 409, data: { recoveryLost: true } });
		expect(sendStaffConversationReply).toHaveBeenCalledOnce();
	});
	it('fails closed for pointers this process never issued, such as after a restart', async () => {
		const loaded = await loadConversation(event({}, '00000000-0000-4000-8000-000000000000'));
		expect(loaded).toMatchObject({ recoveryLost: true, reply: null });
		const stale = createIntent('me', mayaId, { expectEmptyConversation: true })!;
		expire(stale);
		expect(resolveIntent(stale.key, 'someone-else', mayaId)).toEqual({ kind: 'lost' });
	});
});
describe('acknowledgement', () => {
	it('posts only the observed watermark, even when the gate read shows a newer one', async () => {
		const newer = conversationFixture();
		newer.attention.throughRecordedOrder = 13;
		vi.mocked(getStaffTimeline).mockResolvedValue({ ok: true, data: newer, setCookies: [] });
		vi.mocked(acknowledgeInquiryCommunication).mockResolvedValue({
			ok: false,
			retryAfter: null,
			error: { status: 409, code: 'conversation_changed', message: 'PRIVATE', violations: [] }
		});
		const result = await acknowledgeConversation(event({ throughRecordedOrder: '12' }));
		expect(result).toMatchObject({ status: 409 });
		expect(JSON.stringify(result)).not.toContain('PRIVATE');
		expect(acknowledgeInquiryCommunication).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			mayaId,
			12,
			'session=staff'
		);
	});
	it('refuses when staff cannot read the messages', async () => {
		const grants = permissions.filter((p) => p !== 'fionas.communications.read');
		expect(
			await acknowledgeConversation(event({ throughRecordedOrder: '12' }, undefined, grants))
		).toMatchObject({ status: 403 });
		expect(getStaffTimeline).not.toHaveBeenCalled();
		expect(acknowledgeInquiryCommunication).not.toHaveBeenCalled();
	});
	for (const state of ['UNAVAILABLE', 'FORBIDDEN', 'MISSING', 'EMPTY'] as const)
		it(`refuses while the conversation is ${state}`, async () => {
			const timeline = conversationFixture();
			timeline.conversation = { state };
			timeline.items = timeline.items.filter((i) => i.kind !== 'MESSAGE');
			vi.mocked(getStaffTimeline).mockResolvedValue({ ok: true, data: timeline, setCookies: [] });
			expect(await acknowledgeConversation(event({ throughRecordedOrder: '12' }))).toMatchObject({
				status: 409,
				data: { conversationError: expect.stringContaining('cannot be reviewed') }
			});
			expect(acknowledgeInquiryCommunication).not.toHaveBeenCalled();
		});
	it('refuses when the availability read itself fails', async () => {
		vi.mocked(getStaffTimeline).mockResolvedValue({
			ok: false,
			retryAfter: null,
			error: { status: 503, code: 'unavailable', message: 'PRIVATE', violations: [] }
		});
		expect(await acknowledgeConversation(event({ throughRecordedOrder: '12' }))).toMatchObject({
			status: 409
		});
		expect(acknowledgeInquiryCommunication).not.toHaveBeenCalled();
	});
	it('keeps an unsent composer draft across the acknowledgement PRG, without sending', async () => {
		vi.mocked(acknowledgeInquiryCommunication).mockResolvedValue({
			ok: true,
			status: 204,
			data: null,
			setCookies: []
		});
		const intent = createIntent('me', mayaId, { expectedLatestMessageId: 'm1' })!;
		await expect(
			acknowledgeConversation(
				event({ throughRecordedOrder: '12', key: intent.key, body: '  Half-written\nreply' })
			)
		).rejects.toMatchObject({ status: 303 });
		expect((await loadConversation(event({}, intent.key))).reply).toMatchObject({
			key: intent.key,
			state: 'draft',
			body: '  Half-written\nreply'
		});
		expect(sendStaffConversationReply).not.toHaveBeenCalled();
	});
	it('never rewrites a locked uncertain reply and revives an expired draft with its text', async () => {
		vi.mocked(acknowledgeInquiryCommunication).mockResolvedValue({
			ok: true,
			status: 204,
			data: null,
			setCookies: []
		});
		const locked = createIntent('me', mayaId, { expectEmptyConversation: true })!;
		await sendConversationReply(event({ key: locked.key, body: 'Original' }));
		await expect(
			acknowledgeConversation(event({ throughRecordedOrder: '12', key: locked.key, body: 'Edit' }))
		).rejects.toMatchObject({ status: 303 });
		expect(locked.body).toBe('Original');
		const stale = createIntent('me', mayaId, { expectEmptyConversation: true })!;
		stale.expires = Date.now() - REPLY_TTL_MS;
		const e = event({ throughRecordedOrder: '12', key: stale.key, body: 'Still typing' });
		await expect(acknowledgeConversation(e)).rejects.toMatchObject({ status: 303 });
		const pointer = vi.mocked(e.cookies.set).mock.calls[0][1];
		expect((await loadConversation(event({}, pointer))).reply).toMatchObject({
			state: 'draft',
			body: 'Still typing'
		});
		expect(sendStaffConversationReply).toHaveBeenCalledOnce();
	});
});
