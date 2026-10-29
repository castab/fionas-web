import { createHash, randomUUID } from 'node:crypto';
import type { ReplyDraft, ReplyExpectation } from '../conversation-contract.js';

/** Short-lived recovery, not a message ledger. Deploy one admin replica or use sticky sessions.
 * A surviving HttpOnly pointer with no record fails closed after expiry/restart. No private bodies
 * in cookies, URLs, browser storage or logs. Accepted bodies are erased immediately. */
export const REPLY_TTL_MS = 2 * 60 * 60 * 1000;
export const REPLY_COOKIE = 'fionas_reply_intent';
type Intent = ReplyDraft & {
	userId: string;
	inquiryId: string;
	expires: number;
	pending: boolean;
	bodyDigest?: string;
};
export const replyBodyDigest = (body: string) => createHash('sha256').update(body).digest('hex');
const intents = new Map<string, Intent>();
// Erase expired private text even if no further staff requests arrive.
const cleanup = setInterval(() => {
	for (const [key, intent] of intents)
		if (intent.expires < Date.now() && !intent.pending) intents.delete(key);
}, 60000);
cleanup.unref();
export function findIntent(
	key: string | undefined,
	userId: string,
	inquiryId: string
): Intent | null {
	for (const [id, intent] of intents)
		if (intent.expires < Date.now() && !intent.pending) intents.delete(id);
	const intent = key ? intents.get(key) : undefined;
	return intent && intent.userId === userId && intent.inquiryId === inquiryId ? intent : null;
}
export function createIntent(
	userId: string,
	inquiryId: string,
	expectation: ReplyExpectation,
	body = ''
): Intent | null {
	findIntent(undefined, userId, inquiryId);
	if (intents.size >= 1000) return null;
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
