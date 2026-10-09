import type { Cookies } from '@sveltejs/kit';
import { answersFromFormData, prepareInquiry } from '@fionas/shared';
import { submissionCopy, type SubmissionFailure } from '$lib/inquiry-submission.js';
import { publishInquiry } from './event-bus.js';
import {
	buildInquiryEvent,
	receiptOf,
	type InquiryReceipt,
	type InquirySubmittedEvent
} from './inquiry-event.js';
import { getPriceBook, projectForm, priceInquiry } from './price-book.js';
import { replaySecret, sealReplay, openReplay } from './inquiry-replay.js';
export const newSubmissionToken = (): string => crypto.randomUUID();

/** The logical submission key, sent as `Nats-Msg-Id`: opaque, 1–128 of [A-Za-z0-9_-]. UUIDs fit. */
const SUBMISSION_KEY = /^[A-Za-z0-9_-]{1,128}$/;
export const isSubmissionKey = (value: unknown): value is string =>
	typeof value === 'string' && SUBMISSION_KEY.test(value);
export type SubmitResult =
	| { ok: true; receipt: InquiryReceipt; firstName: string | null }
	| { ok: false; status: number; failure: SubmissionFailure };
export async function submitInquiry(data: FormData): Promise<SubmitResult> {
	const restart = data.get('restartToken');
	const restarting = typeof restart === 'string' && restart !== '';
	const token = restarting ? restart : data.get('submissionToken');
	const revision = data.get('priceRevision');
	const failed = (
		status: number,
		outcome: SubmissionFailure['outcome'],
		extra: Partial<SubmissionFailure> = {}
	): SubmitResult => ({
		ok: false,
		status,
		failure: {
			outcome,
			submissionToken: typeof token === 'string' ? token : undefined,
			priceRevision: typeof revision === 'string' ? revision : undefined,
			...extra
		}
	});
	if (!isSubmissionKey(token) || typeof revision !== 'string' || !revision)
		return failed(400, 'malformed', { formError: submissionCopy.malformed });
	const replaying = !restarting && data.get('outcomeUnknown') === 'true';
	let secret: string;
	try {
		secret = replaySecret();
	} catch {
		return failed(503, replaying ? 'ambiguous' : 'unavailable', {
			formError: submissionCopy.unavailable,
			...(replaying
				? {
						restartToken: newSubmissionToken(),
						replay: { envelope: String(data.get('replayRequest') ?? '') }
					}
				: {})
		});
	}
	let event: InquirySubmittedEvent;
	let envelope: string;
	let answers;
	if (replaying) {
		const verified = openReplay(data.get('replayRequest'), token, secret);
		if (!verified)
			return failed(400, 'ambiguous', {
				formError: submissionCopy.replayUnusable,
				restartToken: newSubmissionToken()
			});
		event = verified;
		envelope = data.get('replayRequest') as string;
		try {
			answers = answersFromFormData(projectForm(getPriceBook()), data);
		} catch {
			/* replay is independent of current pricing */
		}
	} else {
		let book;
		try {
			book = getPriceBook();
		} catch {
			return failed(503, 'unavailable', { formError: submissionCopy.unavailable });
		}
		const form = projectForm(book);
		answers = answersFromFormData(form, data);
		if (revision !== book.revision)
			return failed(409, 'stale', {
				answers,
				refreshedForm: form,
				priceRevision: book.revision,
				submissionToken: newSubmissionToken(),
				formError: 'Our prices changed. Review the updated estimate before sending.'
			});
		const command = prepareInquiry(form, answers);
		if (!command.ok)
			return command.reason === 'invalid'
				? failed(422, 'invalid', { answers, errors: command.errors })
				: failed(503, 'unavailable', { formError: submissionCopy.unavailable });
		try {
			// Priced, identified and timestamped once; every delivery publishes these same bytes.
			event = buildInquiryEvent(priceInquiry(command.request, book), book.revision);
		} catch {
			return failed(503, 'unavailable', { formError: submissionCopy.unavailable });
		}
		envelope = sealReplay(event, token, secret);
	}
	const result = await publishInquiry(event, token, { fresh: !replaying });
	if (result.ok)
		return { ok: true, receipt: receiptOf(event), firstName: firstNameOf(event.data.name) };
	if (result.outcome === 'key_reused')
		return failed(409, 'key_reused', {
			answers,
			formError: submissionCopy.keyReused,
			restartToken: newSubmissionToken()
		});
	// A replay that can't be delivered now leaves the earlier delivery's outcome unknown.
	if (result.outcome === 'unknown' || replaying)
		return failed(503, 'ambiguous', {
			answers,
			replay: { envelope },
			formError: submissionCopy.ambiguous,
			restartToken: newSubmissionToken()
		});
	return failed(503, 'unavailable', { answers, formError: submissionCopy.unavailable });
}

// --- Receipt --------------------------------------------------------------------------------

/**
 * After a 201 the receipt rides in a short-lived, HttpOnly cookie to /book/received (post/redirect/
 * get), so reloading or navigating never re-posts the form. It also carries the customer's first
 * name for the greeting; nothing else from the request.
 */
const RECEIPT_COOKIE = 'fionas_inquiry_receipt';
const RECEIPT_MAX_AGE = 60 * 60;
const MAX_FIRST_NAME_LENGTH = 40;

/** The first word of the name the customer gave, for "Thanks, Maria". */
export function firstNameOf(name: string): string | null {
	const first = name.trim().split(/\s+/)[0]?.slice(0, MAX_FIRST_NAME_LENGTH);
	return first || null;
}

export type StoredReceipt = { receipt: InquiryReceipt; firstName: string | null };

export function storeReceipt(
	cookies: Cookies,
	url: URL,
	receipt: InquiryReceipt,
	firstName: string | null
): void {
	cookies.set(RECEIPT_COOKIE, JSON.stringify({ ...receipt, firstName }), {
		path: '/book',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: RECEIPT_MAX_AGE
	});
}

export function readReceipt(cookies: Cookies): StoredReceipt | null {
	const raw = cookies.get(RECEIPT_COOKIE);
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Partial<InquiryReceipt> & { firstName?: unknown };
		if (typeof value.id !== 'string' || typeof value.createdAt !== 'string') return null;
		return {
			receipt: { id: value.id, createdAt: value.createdAt },
			firstName: typeof value.firstName === 'string' ? firstNameOf(value.firstName) : null
		};
	} catch {
		return null;
	}
}
