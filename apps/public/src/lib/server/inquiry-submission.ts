import type { Cookies } from '@sveltejs/kit';
import {
	answersFromFormData,
	buildInquiryRequest,
	describeViolation,
	reconcileAnswers,
	validateAnswers,
	type ApiError,
	type InquiryForm
} from '@fionas/shared';
import { submissionCopy, type SubmissionFailure } from '$lib/inquiry-submission.js';
import { createInquiry, getInquiryForm, isSubmissionKey, type InquiryReceipt } from './commerce.js';

/*
 * The /book submission flow between the browser and fionas-commerce. The browser posts the
 * customer's answers plus two non-secret hidden values: the logical submission token (sent to the
 * backend as `Idempotency-Key`) and the catalog revision the answers were given against. This
 * module never mints a key for an attempt: the token arrives with the form and is reused for every
 * delivery and retry of that submission. See docs/public-inquiry-submission.md.
 */

/** A new opaque token naming one logical submission. Not a credential. */
export const newSubmissionToken = (): string => crypto.randomUUID();

export type SubmitResult =
	{ ok: true; receipt: InquiryReceipt } | { ok: false; status: number; failure: SubmissionFailure };

/** Visitor-facing copy for a refused POST /inquiries. Never echoes the server's diagnostic text. */
function rejectionMessage(error: ApiError): string {
	if (error.status === 404) return submissionCopy.revisionMissing;
	if (error.status === 422 && error.violations.length > 0) {
		return [...new Set(error.violations.map(describeViolation))].join(' ');
	}
	return describeViolation('');
}

const labelsOf = (form: InquiryForm, keys: string[]) =>
	form.sections
		.flatMap((s) => s.fields)
		.filter((f) => keys.includes(f.key))
		.map((f) => f.label);

/**
 * The catalog moved on: fetch the current form past any cache, fit the answers to it and hand it
 * back for review. Never resubmits; the reviewed form is a new logical submission with a new token.
 */
async function refreshForReview(data: FormData): Promise<SubmitResult> {
	const fresh = await getInquiryForm({ fresh: true });
	if (!fresh.ok) {
		return {
			ok: false,
			status: 409,
			failure: { outcome: 'stale', formError: submissionCopy.staleWithoutForm }
		};
	}
	const form = fresh.data;
	const { answers, changed } = reconcileAnswers(form, answersFromFormData(form, data));
	return {
		ok: false,
		status: 409,
		failure: {
			outcome: 'stale',
			answers,
			refreshedForm: form,
			reviewFields: labelsOf(form, changed),
			catalogRevision: form.catalogRevision,
			submissionToken: newSubmissionToken()
		}
	};
}

/** Runs one delivery of a /book submission. */
export async function submitInquiry(data: FormData): Promise<SubmitResult> {
	// "Send as a new request" (after IDEMPOTENCY_KEY_REUSED) deliberately supplies a new key.
	const restart = data.get('restartToken');
	const token =
		typeof restart === 'string' && restart !== '' ? restart : data.get('submissionToken');
	const revision = Number(data.get('catalogRevision'));
	if (!isSubmissionKey(token) || !Number.isInteger(revision) || revision < 1) {
		console.warn(
			'[inquiry] /book submission without a usable submission token or catalog revision'
		);
		return {
			ok: false,
			status: 400,
			failure: { outcome: 'malformed', formError: submissionCopy.malformed }
		};
	}

	const unavailable = (extra: Partial<SubmissionFailure> = {}): SubmitResult => ({
		ok: false,
		status: 503,
		failure: {
			outcome: 'unavailable',
			formError: submissionCopy.unavailable,
			submissionToken: token,
			catalogRevision: revision,
			...extra
		}
	});

	// The current form maps answers to the request (field keys → submission pointers).
	const current = await getInquiryForm();
	if (!current.ok) return unavailable();
	const form = current.data;
	const answers = answersFromFormData(form, data);

	// Check the answers locally only against the form they were given on. When the catalog has moved
	// on, the backend decides: an earlier commit of this key replays, anything else is stale.
	if (revision === form.catalogRevision) {
		const errors = validateAnswers(form, answers);
		if (Object.keys(errors).length > 0) {
			return {
				ok: false,
				status: 422,
				failure: {
					outcome: 'invalid',
					answers,
					errors,
					submissionToken: token,
					catalogRevision: revision
				}
			};
		}
	}

	// Pinned to the customer's revision, never silently to the current one. No prices or totals.
	const inquiry = buildInquiryRequest({ ...form, catalogRevision: revision }, answers);
	const result = await createInquiry(inquiry, token);
	if (result.ok) return { ok: true, receipt: result.data };

	const { error } = result;
	if (error.status === 409 && error.code === 'CATALOG_REVISION_STALE') {
		return refreshForReview(data);
	}
	if (error.status === 409 && error.code === 'IDEMPOTENCY_KEY_REUSED') {
		// Correct key handling makes this rare: it means one token carried two different requests.
		console.warn(
			`[inquiry] Idempotency-Key ${token} was already used for a different request; not retrying. Check the submission-token lifecycle.`
		);
		return {
			ok: false,
			status: 409,
			failure: {
				outcome: 'key_reused',
				answers,
				formError: submissionCopy.keyReused,
				submissionToken: token,
				catalogRevision: revision,
				restartToken: newSubmissionToken()
			}
		};
	}
	if (error.status === 400 || error.status === 404 || error.status === 422) {
		if (error.status === 400) console.warn('[inquiry] POST /inquiries rejected as malformed');
		return {
			ok: false,
			status: 422,
			failure: {
				outcome: 'rejected',
				answers,
				formError: rejectionMessage(error),
				submissionToken: token,
				catalogRevision: revision
			}
		};
	}
	return unavailable({ answers });
}

// --- Receipt --------------------------------------------------------------------------------

/**
 * After a 201 the receipt rides in a short-lived, HttpOnly cookie to /book/received (post/redirect/
 * get), so reloading or navigating never re-posts the form.
 */
const RECEIPT_COOKIE = 'fionas_inquiry_receipt';
const RECEIPT_MAX_AGE = 60 * 60;

export function storeReceipt(cookies: Cookies, url: URL, receipt: InquiryReceipt): void {
	cookies.set(RECEIPT_COOKIE, JSON.stringify(receipt), {
		path: '/book',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: RECEIPT_MAX_AGE
	});
}

export function readReceipt(cookies: Cookies): InquiryReceipt | null {
	const raw = cookies.get(RECEIPT_COOKIE);
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Partial<InquiryReceipt>;
		return typeof value.id === 'string' && typeof value.createdAt === 'string'
			? { id: value.id, createdAt: value.createdAt }
			: null;
	} catch {
		return null;
	}
}
