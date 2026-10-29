import { createHash, randomUUID } from 'node:crypto';
import type { ReplyDraft, ReplyExpectation } from '../conversation-contract.js';

/** Short-lived recovery, not a message ledger. Deploy one admin replica or use sticky sessions.
 * A pointer this process never issued (restart, another replica) fails closed. No private bodies
 * in cookies, URLs, browser storage or logs. Accepted bodies are erased immediately. */
export const REPLY_TTL_MS = 2 * 60 * 60 * 1000;
export const REPLY_COOKIE = 'fionas_reply_intent';
/** The pointer cookie's lifetime. Retirement markers outlive it, so every pointer this process
 * issued stays classifiable for as long as a browser can present it. */
export const REPLY_POINTER_MAX_AGE_S = 7 * 24 * 60 * 60;
const RETIRED_TTL_MS = REPLY_POINTER_MAX_AGE_S * 1000 + REPLY_TTL_MS;
const MAX_INTENTS = 1000;
const MAX_RETIRED = 20000;
type Intent = ReplyDraft & {
	userId: string;
	inquiryId: string;
	expires: number;
	pending: boolean;
	bodyDigest?: string;
};
/** What survives an expired record: no body, only whether its send may have happened. */
export type RetiredIntent = {
	userId: string;
	inquiryId: string;
	expectation: ReplyExpectation;
	state: ReplyDraft['state'];
	expires: number;
};
export type ResolvedIntent =
	| { kind: 'intent'; intent: Intent }
	/** Never attempted, definitively refused, or already accepted: no unresolved send exists. */
	| { kind: 'expired'; retired: RetiredIntent }
	/** An attempted send whose outcome is unknown, or a pointer this process cannot classify. */
	| { kind: 'lost' };
export const replyBodyDigest = (body: string) => createHash('sha256').update(body).digest('hex');
const intents = new Map<string, Intent>();
const retired = new Map<string, RetiredIntent>();
function sweep() {
	const now = Date.now();
	for (const [key, intent] of intents)
		if (intent.expires < now && !intent.pending) {
			intents.delete(key);
			retired.set(key, {
				userId: intent.userId,
				inquiryId: intent.inquiryId,
				expectation: intent.expectation,
				state: intent.state,
				expires: now + RETIRED_TTL_MS
			});
		}
	for (const [key, marker] of retired) if (marker.expires < now) retired.delete(key);
}
// Erase expired private text even if no further staff requests arrive.
const cleanup = setInterval(sweep, 60000);
cleanup.unref();
export function resolveIntent(key: string, userId: string, inquiryId: string): ResolvedIntent {
	sweep();
	const intent = intents.get(key);
	if (intent) {
		return intent.userId === userId && intent.inquiryId === inquiryId
			? { kind: 'intent', intent }
			: { kind: 'lost' };
	}
	const marker = retired.get(key);
	// Only an expired record that had a send in flight with no known outcome stays unresolved.
	return marker &&
		marker.userId === userId &&
		marker.inquiryId === inquiryId &&
		marker.state !== 'uncertain'
		? { kind: 'expired', retired: marker }
		: { kind: 'lost' };
}
export function findIntent(key: string | undefined, userId: string, inquiryId: string) {
	const resolved = key ? resolveIntent(key, userId, inquiryId) : null;
	return resolved?.kind === 'intent' ? resolved.intent : null;
}
export function createIntent(
	userId: string,
	inquiryId: string,
	expectation: ReplyExpectation,
	body = ''
): Intent | null {
	sweep();
	// Full stores fail closed: no composer rather than an unclassifiable pointer.
	if (intents.size >= MAX_INTENTS || retired.size >= MAX_RETIRED) return null;
	const intent: Intent = {
		key: randomUUID(),
		userId,
		inquiryId,
		expectation,
		body,
		state: 'draft',
		expires: Date.now() + REPLY_TTL_MS,
		pending: false
	};
	intents.set(intent.key, intent);
	return intent;
}
export function publicIntent(intent: Intent): ReplyDraft {
	return {
		key: intent.key,
		body: intent.body,
		expectation: intent.expectation,
		state: intent.state,
		message: intent.message
	};
}
