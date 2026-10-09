import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { isInquirySubmittedEvent, type InquirySubmittedEvent } from './inquiry-event.js';

/** Version 1 envelopes held commerce POST bodies; they are refused like any other unusable one. */
const ENVELOPE_VERSION = 2;
const WINDOW_MS = 24 * 60 * 60 * 1000;
export function replaySecret(): string {
	const secret = env.FIONAS_REPLAY_SECRET;
	if (!secret || Buffer.byteLength(secret) < 32) throw new Error('Replay signing unavailable');
	return secret;
}
const digest = (command: string) => createHash('sha256').update(command).digest('hex');
export function sealReplay(
	event: InquirySubmittedEvent,
	key: string,
	secret = replaySecret(),
	now = Date.now()
): string {
	const command = JSON.stringify(event);
	const payload = Buffer.from(
		JSON.stringify({ v: ENVELOPE_VERSION, key, issuedAt: now, digest: digest(command), command })
	).toString('base64url');
	return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
export function openReplay(
	envelope: unknown,
	key: string,
	secret = replaySecret(),
	now = Date.now()
): InquirySubmittedEvent | null {
	if (typeof envelope !== 'string' || envelope.length > 65_536) return null;
	try {
		const parts = envelope.split('.');
		if (
			parts.length !== 2 ||
			!/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
			!/^[A-Za-z0-9_-]{43}$/.test(parts[1])
		)
			return null;
		const expected = createHmac('sha256', secret).update(parts[0]).digest();
		const signature = Buffer.from(parts[1], 'base64url');
		if (
			signature.toString('base64url') !== parts[1] ||
			signature.length !== expected.length ||
			!timingSafeEqual(signature, expected)
		)
			return null;
		const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
		if (
			payload.v !== ENVELOPE_VERSION ||
			payload.key !== key ||
			!Number.isSafeInteger(payload.issuedAt) ||
			payload.issuedAt > now ||
			now - payload.issuedAt > WINDOW_MS ||
			typeof payload.command !== 'string' ||
			digest(payload.command) !== payload.digest
		)
			return null;
		const command: unknown = JSON.parse(payload.command);
		return isInquirySubmittedEvent(command) ? command : null;
	} catch {
		return null;
	}
}
