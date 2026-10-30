import type {
	CommunicationSummary,
	ConversationMessage,
	ReplyExpectation,
	StaffTimeline,
	TimelineActor,
	TimelineItem
} from './conversation-contract.js';
import { isFinancialDocumentHistory, isDepositRequirementHistory } from './revision-history.js';

const object = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const optionalText = (v: unknown) => v == null || typeof v === 'string';
const instant = (v: unknown) =>
	typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));
const integer = (v: unknown): v is number =>
	typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const money = (v: unknown) => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);
const actor = (v: unknown) =>
	object(v) && ['USER', 'SERVICE'].includes(String(v.principalKind)) && text(v.principalId);
export function isCommunicationSummary(v: unknown): v is CommunicationSummary {
	return (
		object(v) &&
		typeof v.needsReply === 'boolean' &&
		integer(v.throughRecordedOrder) &&
		(v.unacknowledgedSince == null || instant(v.unacknowledgedSince)) &&
		(v.latestEmailAt == null || instant(v.latestEmailAt)) &&
		(v.lastAcknowledged == null ||
			(object(v.lastAcknowledged) &&
				actor(v.lastAcknowledged) &&
				instant(v.lastAcknowledged.occurredAt)))
	);
}
const classification = (v: unknown) => v === 'DEPOSIT' || v === 'ADDITIONAL';
function financial(v: unknown, inquiryId: string): boolean {
	if (
		!object(v) ||
		!text(v.id) ||
		!integer(v.version) ||
		v.currency !== 'USD' ||
		v.inquiryId !== inquiryId
	)
		return false;
	return isFinancialDocumentHistory(
		{ id: v.id, inquiryId, versions: [v] },
		{ documentId: v.id, inquiryId, latestVersion: v.version }
	);
}
function allocation(v: unknown): boolean {
	return (
		object(v) &&
		text(v.documentId) &&
		integer(v.documentVersion) &&
		v.documentVersion > 0 &&
		money(v.amount) &&
		v.currency === 'USD' &&
		instant(v.allocatedAt)
	);
}
function item(v: unknown, inquiryId: string): v is TimelineItem {
	if (!object(v) || !text(v.id) || !instant(v.occurredAt)) return false;
	switch (v.kind) {
		case 'MESSAGE':
			return (
				text(v.messageId) &&
				['inbound', 'outbound'].includes(String(v.direction)) &&
				text(v.senderAddress) &&
				text(v.recipient) &&
				optionalText(v.senderName) &&
				optionalText(v.text) &&
				['received', 'pending', 'accepted', 'failed', 'indeterminate'].includes(
					String(v.sendState)
				) &&
				(v.deliveryState == null ||
					[
						'unknown',
						'delivered',
						'delivery_delayed',
						'bounced',
						'complained',
						'suppressed',
						'failed'
					].includes(String(v.deliveryState)))
			);
		case 'QUOTE_PUBLISHED': {
			if (
				!financial(v.financial, inquiryId) ||
				!object(v.financial) ||
				v.financial.stage !== 'QUOTE' ||
				!actor(v.actor) ||
				!object(v.proposal)
			)
				return false;
			const p = v.proposal;
			return (
				text(p.id) &&
				p.inquiryId === inquiryId &&
				p.documentId === v.financial.id &&
				p.documentVersion === v.financial.version &&
				instant(p.issuedAt) &&
				text(p.issuedBy) &&
				text(p.issuanceKind) &&
				integer(p.depositRequirementRevision) &&
				object(v.depositRequirement) &&
				v.depositRequirement.revision === p.depositRequirementRevision &&
				isDepositRequirementHistory(
					{ revisions: [v.depositRequirement] },
					{ documentId: String(v.financial.id), currency: 'USD' }
				)
			);
		}
		case 'INVOICE_AMENDED':
			return (
				financial(v.financial, inquiryId) && object(v.financial) && v.financial.stage === 'INVOICE'
			);
		case 'PAYMENT_RECORDED':
		case 'REFUND_RECORDED': {
			if (
				!text(v.paymentId) ||
				!money(v.amount) ||
				v.currency !== 'USD' ||
				!text(v.method) ||
				(v.externalReference != null &&
					(!object(v.externalReference) ||
						!text(v.externalReference.provider) ||
						!text(v.externalReference.reference)))
			)
				return false;
			if (v.kind === 'PAYMENT_RECORDED')
				return (
					classification(v.classification) &&
					(v.classification !== 'DEPOSIT' ||
						(text(v.proposalId) &&
							integer(v.depositRequirementRevision) &&
							v.depositRequirementRevision > 0)) &&
					Array.isArray(v.allocations) &&
					v.allocations.every(
						(a) =>
							object(a) &&
							allocation(a) &&
							text(a.allocationId) &&
							typeof a.canonical === 'boolean' &&
							optionalText(a.documentStage)
					)
				);
			return (
				text(v.refundId) &&
				classification(v.paymentClassification) &&
				Array.isArray(v.unwound) &&
				v.unwound.every(
					(a) =>
						object(a) && allocation(a) && text(a.refundAllocationId) && text(a.paymentAllocationId)
				)
			);
		}
		case 'COMMUNICATION_ACKNOWLEDGED':
		case 'SERVED':
		case 'CLOSED':
			return actor(v.actor);
		case 'DECLINED':
			return actor(v.actor) && text(v.reason);
		default:
			return false;
	}
}
/** Reject the optional read as a unit, preserving order. Never expose restricted message content. */
export function isStaffTimeline(v: unknown, inquiryId: string): v is StaffTimeline {
	if (
		!object(v) ||
		!object(v.conversation) ||
		!isCommunicationSummary(v.attention) ||
		!Array.isArray(v.items)
	)
		return false;
	const c = v.conversation;
	if (
		!['READY', 'EMPTY', 'MISSING', 'UNAVAILABLE', 'FORBIDDEN'].includes(String(c.state)) ||
		!optionalText(c.subject) ||
		!optionalText(c.providerState) ||
		!optionalText(c.latestMessageId) ||
		!v.items.every((i) => item(i, inquiryId))
	)
		return false;
	const messages = v.items.filter((i) => i.kind === 'MESSAGE');
	return (
		new Set(v.items.map((i) => i.id)).size === v.items.length &&
		new Set(messages.map((i) => i.messageId)).size === messages.length &&
		(c.state === 'READY'
			? messages.length === 0
				? c.latestMessageId == null
				: messages.some((m) => m.messageId === c.latestMessageId)
			: messages.length === 0 && c.latestMessageId == null)
	);
}
export function replyExpectation(timeline: StaffTimeline | null): ReplyExpectation | null {
	const c = timeline?.conversation;
	if (c?.state === 'EMPTY' || (c?.state === 'READY' && !c.latestMessageId))
		return { expectEmptyConversation: true };
	return c?.state === 'READY' && c.latestMessageId
		? { expectedLatestMessageId: c.latestMessageId }
		: null;
}
/** Native form encoding sends CRLF; enhanced submissions send LF. One body, one fingerprint. */
export const plainNewlines = (value: string) => value.replace(/\r\n?/g, '\n');
export function replyBody(value: string): string | null {
	const body = plainNewlines(value).trim();
	// Backend Kotlin String length is UTF-16, as is JavaScript's length.
	return body.length > 0 &&
		body.length <= 5000 &&
		// eslint-disable-next-line no-control-regex -- matches the backend plain-text validation
		!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(body)
		? body
		: null;
}
export function messageStatus(message: ConversationMessage): string[] {
	if (message.direction === 'inbound') return ['Received'];
	const send = {
		received: 'Received',
		pending: 'Queued to send',
		accepted: 'Accepted by email provider',
		failed: 'Failed to send',
		indeterminate: 'Send status uncertain'
	};
	const delivery = {
		unknown: 'Delivery not confirmed',
		delivered: 'Delivered',
		delivery_delayed: 'Delivery delayed',
		bounced: 'Bounced',
		complained: 'Reported as spam',
		suppressed: 'Delivery suppressed',
		failed: 'Delivery failed'
	};
	return [send[message.sendState], delivery[message.deliveryState ?? 'unknown']];
}
const blankLine = (line: string) => !line.trim();
const quotedLine = (line: string) => /^\s*>/.test(line);
/** Where a mail client's trailing quoted history starts: an `On … wrote:` attribution (wrapped over
 * up to three lines) above `>` lines, two or more bare `>` lines, or an Outlook header block. */
function quotedTrailStart(lines: string[]): number | null {
	let start = lines.length;
	while (start > 0 && (blankLine(lines[start - 1]) || quotedLine(lines[start - 1]))) start--;
	while (start < lines.length && blankLine(lines[start])) start++;
	if (start < lines.length) {
		let above = start - 1;
		while (above >= 0 && blankLine(lines[above])) above--;
		if (above >= 0 && /wrote:\s*$/i.test(lines[above])) {
			for (let i = above; i >= Math.max(0, above - 2) && !blankLine(lines[i]); i--)
				if (/^\s*On\s/i.test(lines[i])) return i;
			return above;
		}
		return lines.slice(start).filter(quotedLine).length >= 2 ? start : null;
	}
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i.test(lines[i])) return i;
		const header = lines.slice(i + 1, i + 6);
		if (
			/^\s*From:\s*\S/i.test(lines[i]) &&
			header.some((l) => /^\s*(Sent|Date):\s*\S/i.test(l)) &&
			header.some((l) => /^\s*Subject:/i.test(l))
		)
			return i;
	}
	return null;
}
/** Display only: separates a message's own words from the quoted history appended below it, so the
 * workspace can fold it. Inline replies, fully quoted messages and unmatched text stay whole. */
export function splitQuotedTrail(text: string): { body: string; quoted: string | null } {
	const lines = plainNewlines(text).split('\n');
	const start = quotedTrailStart(lines);
	const body = start === null ? '' : lines.slice(0, start).join('\n').trimEnd();
	return start === null || blankLine(body)
		? { body: text, quoted: null }
		: { body, quoted: lines.slice(start).join('\n').trim() };
}
export function actorLabel(actor: TimelineActor, userId: string): string {
	return actor.principalKind === 'USER'
		? actor.principalId === userId
			? 'You'
			: 'Staff'
		: 'System';
}
export const availabilityCopy = {
	READY: 'Messages and booking history, in chronological order.',
	EMPTY: 'No booking email conversation exists yet.',
	MISSING:
		'The established conversation cannot currently be found. Contact an administrator; a replacement will not be opened.',
	UNAVAILABLE: 'Email is temporarily unavailable. You can continue working on this booking.',
	FORBIDDEN: 'Email content is not accessible with the current permissions or connection.'
};
export function replyError(code: string): string {
	const copy: Record<string, string> = {
		conversation_changed:
			'New communication arrived. Review the refreshed conversation before preparing a new send intent.',
		conversation_missing:
			'The established conversation is missing. Contact an administrator before replying.',
		IDEMPOTENCY_KEY_REUSED:
			'This send key belongs to a different reply. Do not send again; review the conversation and contact an administrator.',
		email_sending_disabled: 'Outgoing email is not enabled. Your reply has been kept.',
		email_recipient_not_allowed:
			'Email is not enabled for this recipient. Contact an administrator.',
		email_provider_unavailable:
			'Email could not be reached before sending. Your reply has been kept for an explicit retry.',
		email_send_rejected:
			'The email provider rejected this reply. Review it before preparing a new send intent.',
		forbidden: 'You do not have permission to send this reply.',
		validation_failed: 'Enter a plain-text reply of 1–5,000 characters without control characters.'
	};
	return Object.hasOwn(copy, code)
		? copy[code]
		: 'Send status not yet confirmed. Review the timeline or reconcile the exact original reply. Do not send it again with a new key.';
}
