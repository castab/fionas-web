import { describe, expect, it } from 'vitest';
import {
	actorLabel,
	isCommunicationSummary,
	isStaffTimeline,
	messageStatus,
	replyBody,
	replyError,
	replyExpectation,
	splitQuotedTrail,
	timelineDayBreaks,
	timelineDayLabel,
	timelineTimeLabel
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
	it('labels Activity days and times in Pacific time without reordering items', () => {
		// 06:30Z is still the previous evening in Los Angeles.
		expect(timelineDayLabel('2026-11-04T06:30:00Z')).toBe('Tuesday, Nov 3, 2026');
		expect(timelineTimeLabel('2026-11-03T22:50:00Z')).toBe('2:50 PM');
		const items = [
			{ occurredAt: '2026-11-03T19:54:00Z' },
			{ occurredAt: '2026-11-03T22:50:00Z' },
			{ occurredAt: '2026-11-04T06:30:00Z' },
			{ occurredAt: '2026-11-04T18:00:00Z' },
			// Backend order wins: an earlier day after a later one gets its own heading again.
			{ occurredAt: '2026-11-03T23:00:00Z' }
		];
		const before = structuredClone(items);
		expect(timelineDayBreaks(items)).toEqual([
			'Tuesday, Nov 3, 2026',
			null,
			null,
			'Wednesday, Nov 4, 2026',
			'Tuesday, Nov 3, 2026'
		]);
		expect(items).toEqual(before);
	});
});

describe('financial email timeline', () => {
	const email = (): Record<string, unknown> => ({
		sendId: '40000000-0000-4000-8000-000000000001',
		kind: 'QUOTE',
		documentId: '10000000-0000-0000-0000-000000000003',
		documentVersion: 2,
		businessRevision: 2,
		proposalId: '30000000-0000-0000-0000-000000000003',
		current: true,
		outcome: 'ACCEPTED',
		requestedAt: '2026-07-17T18:00:00Z',
		acceptedAt: '2026-07-17T18:00:01Z',
		actor: { principalKind: 'USER', principalId: '00000000-0000-0000-0000-000000000001' }
	});
	function withEmail() {
		const value = conversationFixture() as unknown as {
			items: unknown[];
			financialEmails?: Record<string, unknown>[];
		};
		const outbound: Record<string, unknown> = {
			kind: 'MESSAGE',
			id: 'message:50000000-0000-4000-8000-000000000001',
			messageId: '50000000-0000-4000-8000-000000000001',
			occurredAt: '2026-10-28T19:00:00Z',
			direction: 'outbound',
			senderAddress: 'bookings@fionas.example',
			recipient: 'maya@example.com',
			text: 'Hi Maya, here’s your quote',
			sendState: 'accepted'
		};
		value.items.splice(1, 0, outbound);
		outbound.financialEmail = { ...email(), messageId: outbound.messageId };
		outbound.textVisibility = 'READABLE';
		outbound.textOmittedForPaymentSecurity = false;
		value.financialEmails = [
			{ ...email(), messageId: outbound.messageId },
			{
				...email(),
				sendId: '40000000-0000-4000-8000-000000000002',
				outcome: 'UNKNOWN',
				acceptedAt: undefined
			}
		];
		return { value, outbound };
	}

	it('accepts command history and the matching MESSAGE metadata, with full readable text', () => {
		const { value, outbound } = withEmail();
		outbound.text = 'Pay here: https://pay.example/pay/abc#secret\n\n> On Mon, you wrote:';
		expect(isStaffTimeline(value, mayaId)).toBe(true);
		// Backward compatible: older commerce sends neither field.
		expect(isStaffTimeline(conversationFixture(), mayaId)).toBe(true);
	});

	it('handles empty readable text and provider-unavailable content distinctly', () => {
		const { value, outbound } = withEmail();
		outbound.text = '';
		expect(isStaffTimeline(value, mayaId)).toBe(true);
		outbound.textVisibility = 'PROVIDER_CONTENT_UNAVAILABLE';
		expect(isStaffTimeline(value, mayaId)).toBe(false);
		delete outbound.text;
		expect(isStaffTimeline(value, mayaId)).toBe(true);
		outbound.textVisibility = 'FINANCIAL_EMAIL_PROTECTED';
		expect(isStaffTimeline(value, mayaId)).toBe(false);
	});

	it('rejects metadata for another message, duplicate commands and malformed history', () => {
		const mismatch = withEmail();
		(mismatch.outbound.financialEmail as Record<string, unknown>).messageId =
			'50000000-0000-4000-8000-00000000000f';
		expect(isStaffTimeline(mismatch.value, mayaId)).toBe(false);
		const duplicate = withEmail();
		duplicate.value.financialEmails!.push(duplicate.value.financialEmails![0]);
		expect(isStaffTimeline(duplicate.value, mayaId)).toBe(false);
		const malformed = withEmail();
		malformed.value.financialEmails = [{ ...email(), outcome: 'DELIVERED' }];
		expect(isStaffTimeline(malformed.value, mayaId)).toBe(false);
	});
});

describe('quoted reply history', () => {
	it('folds a wrapped Gmail attribution and its nested quotes', () => {
		const text = [
			'Another follow up just to see.',
			'',
			'On Thu, Oct 29, 2026 at 1:14 PM Brayan Castaneda <',
			'bcastaneda@example.com> wrote:',
			'',
			'> Great! It works!',
			'>',
			'> On Thu, Oct 29, 2026, 1:13 PM Fiona’s Ice Cream <',
			'> bookings@example.com> wrote:',
			'>',
			'>> Hey there, we got your request!',
			'>>',
			'>'
		].join('\r\n');
		const { body, quoted } = splitQuotedTrail(text);
		expect(body).toBe('Another follow up just to see.');
		expect(quoted).toMatch(/^On Thu, Oct 29, 2026 at 1:14 PM/);
		expect(quoted).toContain('>> Hey there, we got your request!');
	});

	it('folds bare quote blocks and Outlook headers', () => {
		expect(splitQuotedTrail('Sounds good.\n\n> Can you come at 3?\n> Thanks')).toEqual({
			body: 'Sounds good.',
			quoted: '> Can you come at 3?\n> Thanks'
		});
		expect(
			splitQuotedTrail(
				'See you then.\n\nFrom: Fiona’s <bookings@example.com>\nSent: Thursday\nTo: Maya\nSubject: Booking\n\nHello'
			).quoted
		).toMatch(/^From: Fiona’s/);
		expect(splitQuotedTrail('Yes.\n-----Original Message-----\nFrom: someone').quoted).toMatch(
			/^-----Original Message-----/
		);
	});

	it('keeps inline replies, single quoted lines, fully quoted mail and plain text whole', () => {
		for (const text of [
			'Just a plain note.\nFrom: me, a happy customer',
			'> Can you come at 3?\nYes, 3 works.\n> Parking?\nStreet parking is fine.',
			'We will have\n> 50 guests',
			'On Monday, Maya wrote:\n> Hello\n> again',
			'> only\n> quoted'
		])
			expect(splitQuotedTrail(text)).toEqual({ body: text, quoted: null });
	});
});
