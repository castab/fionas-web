import {
	createCipheriv,
	createDecipheriv,
	hkdfSync,
	randomBytes,
	randomUUID,
	createHash
} from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { Cookies } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { ReplyExpectation } from '../conversation-contract.js';
import type {
	FinancialEmailDraft,
	FinancialEmailDraftState,
	FinancialEmailIntent,
	FinancialEmailKind
} from '../financial-email-contract.js';

/**
 * Exact-command recovery for financial emails.
 *
 * Before any send, the complete original command (key, email intent including the message, review
 * token and original conversation expectation) is sealed with AES-256-GCM into HttpOnly,
 * SameSite=Strict cookies scoped to this inquiry's workspace path and bound (as authenticated data)
 * to the staff user and inquiry. The key is minted at preview time, so every submission of one
 * review, including a duplicate click, a native resubmit or a browser retry after a lost response,
 * repeats the same key and body. Nothing is held in server memory, so the record survives a
 * restart and works across admin instances, provided they share `ADMIN_RECOVERY_SECRET`.
 *
 * The browser cannot read or forge the record. Commerce never receives it (`forwardedCookie`).
 * It never contains a payment URL or bearer: previews are inert and sends return none.
 */

export const RECOVERY_COOKIE = 'fionas_fe';
/** Long enough to outlast an investigation; commerce itself has no TTL for UNKNOWN commands. */
export const RECOVERY_MAX_AGE_S = 30 * 24 * 60 * 60;
const CHUNKS = 3;
const CHUNK_LENGTH = 3600;
const VERSION = 1;

/** The sealed record. `email` carries the exact message; `reviewToken` the preview's token. */
export type RecoveryRecord = {
	v: typeof VERSION;
	userId: string;
	inquiryId: string;
	key: string;
	reviewId: string;
	email: FinancialEmailIntent;
	reviewToken: string;
	expectation: ReplyExpectation;
	reviewedAt: string;
	state: FinancialEmailDraftState | 'accepted';
	code?: string;
	sendId?: string;
	replayed?: boolean;
};

let warned = false;
let fallback: Buffer | null = null;
/** HKDF from the shared secret; without one, a per-process key (recovery then fails closed). */
function cipherKey(): Buffer {
	const secret = env.ADMIN_RECOVERY_SECRET?.trim();
	if (secret && secret.length >= 32)
		return Buffer.from(
			hkdfSync('sha256', secret, 'fionas-admin', 'financial-email-recovery.v1', 32)
		);
	if (!warned) {
		warned = true;
		// Operator hint only: names the setting, never a value.
		console.warn(
			'[financial-email] ADMIN_RECOVERY_SECRET is unset or shorter than 32 characters; recovery records will not survive a restart or span admin instances'
		);
	}
	return (fallback ??= randomBytes(32));
}

const aad = (inquiryId: string, userId: string) =>
	Buffer.from(`fionas.financial-email.v${VERSION}|${inquiryId}|${userId}`);

export function seal(record: RecoveryRecord): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', cipherKey(), iv);
	cipher.setAAD(aad(record.inquiryId, record.userId));
	const body = Buffer.concat([
		cipher.update(deflateRawSync(Buffer.from(JSON.stringify(record)))),
		cipher.final()
	]);
	return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]).toString(
		'base64url'
	);
}

export function unseal(value: string, inquiryId: string, userId: string): RecoveryRecord | null {
	try {
		const raw = Buffer.from(value, 'base64url');
		if (raw.length < 30 || raw[0] !== VERSION) return null;
		const decipher = createDecipheriv('aes-256-gcm', cipherKey(), raw.subarray(1, 13));
		decipher.setAAD(aad(inquiryId, userId));
		decipher.setAuthTag(raw.subarray(13, 29));
		const plain = Buffer.concat([decipher.update(raw.subarray(29)), decipher.final()]);
		const record = JSON.parse(inflateRawSync(plain, { maxOutputLength: 64 * 1024 }).toString());
		return record?.v === VERSION &&
			record.inquiryId === inquiryId &&
			record.userId === userId &&
			typeof record.key === 'string' &&
			/^[A-Za-z0-9_-]{1,128}$/.test(record.key) &&
			typeof record.reviewId === 'string'
			? (record as RecoveryRecord)
			: null;
	} catch {
		return null;
	}
}

type Event = { cookies: Cookies; url: URL; params: Partial<Record<string, string>> };
const options = (event: Event) => ({
	path: `/requests/${encodeURIComponent(event.params.inquiryId!)}`,
	httpOnly: true,
	sameSite: 'strict' as const,
	secure: event.url.protocol === 'https:',
	maxAge: RECOVERY_MAX_AGE_S
});

export type StoredRecovery =
	| { kind: 'none' }
	| { kind: 'record'; record: RecoveryRecord }
	/** Present but unreadable: another user, another secret, a restart without one, or tampering. */
	| { kind: 'unreadable' };

export function readRecovery(event: Event, userId: string): StoredRecovery {
	const parts: string[] = [];
	for (let i = 0; i < CHUNKS; i++) {
		const part = event.cookies.get(`${RECOVERY_COOKIE}${i}`);
		if (part === undefined) break;
		parts.push(part);
	}
	if (!parts.length) return { kind: 'none' };
	const record = unseal(parts.join(''), event.params.inquiryId!, userId);
	return record ? { kind: 'record', record } : { kind: 'unreadable' };
}

/** Writes the sealed record; false when it cannot fit (the caller must then not send). */
export function writeRecovery(event: Event, record: RecoveryRecord): boolean {
	const sealed = seal(record);
	if (sealed.length > CHUNKS * CHUNK_LENGTH) return false;
	const opts = options(event);
	for (let i = 0; i < CHUNKS; i++) {
		const part = sealed.slice(i * CHUNK_LENGTH, (i + 1) * CHUNK_LENGTH);
		if (part) event.cookies.set(`${RECOVERY_COOKIE}${i}`, part, opts);
		else event.cookies.delete(`${RECOVERY_COOKIE}${i}`, opts);
	}
	return true;
}

export function clearRecovery(event: Event) {
	const opts = options(event);
	for (let i = 0; i < CHUNKS; i++) event.cookies.delete(`${RECOVERY_COOKIE}${i}`, opts);
}

export function newRecord(
	userId: string,
	inquiryId: string,
	email: FinancialEmailIntent,
	reviewToken: string,
	expectation: ReplyExpectation
): RecoveryRecord {
	return {
		v: VERSION,
		userId,
		inquiryId,
		key: randomUUID(),
		reviewId: randomUUID(),
		email,
		reviewToken,
		expectation,
		reviewedAt: new Date().toISOString(),
		state: 'reviewed'
	};
}

/** One digest of everything the command fingerprints, so an identical re-review keeps its key. */
export function commandDigest(
	email: FinancialEmailIntent,
	reviewToken: string,
	expectation: ReplyExpectation
): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				email.kind,
				email.documentId,
				email.expectedDocumentVersion,
				email.expectedBusinessRevision,
				email.proposalId ?? null,
				email.expectedDepositRequirementRevision ?? null,
				email.message ?? null,
				reviewToken,
				expectation.expectedLatestMessageId ?? null,
				expectation.expectEmptyConversation ?? null
			])
		)
		.digest('hex');
}

/** The browser's view: never the key or the review token. */
export function publicDraft(
	record: RecoveryRecord,
	possiblyAttempted = false
): FinancialEmailDraft | null {
	if (record.state === 'accepted') return null;
	const { message, ...intent } = record.email;
	return {
		reviewId: record.reviewId,
		intent,
		message: message ?? '',
		expectation: record.expectation,
		reviewedAt: record.reviewedAt,
		state: record.state,
		...(record.code && { code: record.code }),
		...(record.sendId && { sendId: record.sendId }),
		...(possiblyAttempted && record.state === 'reviewed' && { possiblyAttempted: true })
	};
}

/** In-flight keys on this instance, so overlapping submissions of one review never race here. */
const pending = new Set<string>();
export const sendPending = {
	has: (key: string) => pending.has(key),
	add: (key: string) => pending.add(key),
	delete: (key: string) => pending.delete(key)
};

export type AcceptedNotice = { sendId: string; replayed: boolean; kind: FinancialEmailKind };
