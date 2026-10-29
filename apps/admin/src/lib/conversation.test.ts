import { describe, expect, it } from 'vitest';
import {
	actorLabel,
	isCommunicationSummary,
	isStaffTimeline,
	messageStatus,
	replyBody,
	replyError,
	replyExpectation
} from './conversation.js';
import type { ConversationMessage, DeliveryState, SendState } from './conversation-contract.js';
import { conversationFixture, milestoneFixture } from '../../e2e/conversation-fixture.mjs';
import { mayaId } from '../../e2e/request-fixture.mjs';
import { receivedTimeLabel } from './payments.js';

describe('conversation boundary', () => {
	it('validates every milestone and exact allocation version without sorting or calculating', () => {
		const value = milestoneFixture();
		const before = structuredClone(value);
		expect(isStaffTimeline(value, mayaId)).toBe(true);
		expect(value).toEqual(before);
		const refund = value.items.find((i) => i.kind === 'REFUND_RECORDED');
		if (!refund || refund.kind !== 'REFUND_RECORDED') throw new Error('Missing refund');
		refund.unwound[0].documentVersion = 0;
		expect(isStaffTimeline(value, mayaId)).toBe(false);
	});
	it('validates the backend order and historical quote without rebuilding either', () => {
		const value = conversationFixture();
		const before = structuredClone(value);
		expect(isStaffTimeline(value, mayaId)).toBe(true);
		expect(value).toEqual(before);
		expect(isStaffTimeline(value, 'other-inquiry')).toBe(false);
	});
	it.each(['EMPTY', 'MISSING', 'UNAVAILABLE', 'FORBIDDEN'] as const)(
		'keeps %s separate and refuses leaked bodies',
		(state) => {
			const value = conversationFixture();
			value.conversation = { state };
			expect(isStaffTimeline(value, mayaId)).toBe(false);
			value.items = value.items.filter((i) => i.kind !== 'MESSAGE');
			expect(isStaffTimeline(value, mayaId)).toBe(true);
			expect(replyExpectation(value)).toEqual(
				state === 'EMPTY' ? { expectEmptyConversation: true } : null
			);
		}
	);
	it('supports READY with no messages and null plain text', () => {
		const value = conversationFixture();
		const message = value.items[1] as ConversationMessage;
		message.text = null;
		expect(isStaffTimeline(value, mayaId)).toBe(true);
		value.items = [];
		delete value.conversation.latestMessageId;
		expect(isStaffTimeline(value, mayaId)).toBe(true);
		expect(replyExpectation(value)).toEqual({ expectEmptyConversation: true });
	});
	it('fails closed on malformed timestamps, statuses, money, watermarks and duplicated identities', () => {
		for (const mutate of [
			(v: ReturnType<typeof conversationFixture>) => {
				v.attention.throughRecordedOrder = Number.MAX_SAFE_INTEGER + 1;
			},
			(v: ReturnType<typeof conversationFixture>) => {
				v.items[0].occurredAt = 'yesterday';
			},
			(v: ReturnType<typeof conversationFixture>) => {
				v.items.push(v.items[0]);
			},
			(v: ReturnType<typeof conversationFixture>) => {
				(v.items[1] as ConversationMessage).sendState = 'delivered' as SendState;
			},
			(v: ReturnType<typeof conversationFixture>) => {
				if (v.items[0].kind === 'QUOTE_PUBLISHED') v.items[0].financial.total = 'NaN';
			}
		]) {
			const value = conversationFixture();
			mutate(value);
			expect(isStaffTimeline(value, mayaId)).toBe(false);
		}
		expect(isCommunicationSummary(undefined)).toBe(false);
		expect(isCommunicationSummary({ needsReply: false, throughRecordedOrder: 0 })).toBe(true);
	});
	it('normalizes only edge whitespace and rejects controls or invalid length', () => {
		expect(replyBody('  Hello\n\nMaya\t!  ')).toBe('Hello\n\nMaya\t!');
		expect(replyBody('Hello\r\nMaya\rthere')).toBe('Hello\nMaya\nthere');
		for (const body of ['', '  ', 'a'.repeat(5001), 'Hello\u0000', 'Hello\u0085'])
			expect(replyBody(body)).toBeNull();
		expect(replyBody('a'.repeat(5000))).toHaveLength(5000);
	});
	it.each([
		'unknown',
		'delivered',
		'delivery_delayed',
		'bounced',
		'complained',
		'suppressed',
		'failed'
	] satisfies DeliveryState[])('keeps acceptance separate from %s', (deliveryState) => {
		const message = {
			...(conversationFixture().items[1] as ConversationMessage),
			direction: 'outbound' as const,
			sendState: 'accepted' as const,
			deliveryState
		};
		const labels = messageStatus(message);
		expect(labels[0]).toBe('Accepted by email provider');
		expect(labels.includes('Delivered')).toBe(deliveryState === 'delivered');
	});
	it.each(['received', 'pending', 'accepted', 'failed', 'indeterminate'] satisfies SendState[])(
		'labels send state %s without assuming delivery',
		(sendState) => {
			expect(
				messageStatus({
					...(conversationFixture().items[1] as ConversationMessage),
					direction: 'outbound',
					sendState
				})
			).not.toContain('Delivered');
		}
	);
	it('uses Pacific time and honest principal fallbacks', () => {
		expect(receivedTimeLabel('2026-10-28T20:00:00Z')).toContain('1:00 PM');
		expect(actorLabel({ principalKind: 'USER', principalId: 'me' }, 'me')).toBe('You');
		expect(actorLabel({ principalKind: 'USER', principalId: 'other' }, 'me')).toBe('Staff');
		expect(actorLabel({ principalKind: 'SERVICE', principalId: 'service' }, 'me')).toBe('System');
		expect(replyError('PRIVATE backend secret')).not.toContain('PRIVATE');
	});
});
