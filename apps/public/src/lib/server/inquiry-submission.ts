import type { Cookies } from '@sveltejs/kit';
import {
	answersFromFormData,
	CATALOG_STATE_VIOLATIONS,
	describeViolation,
	prepareInquiry,
	pricingContractProblem,
	reconcileAnswers,
	type ApiError,
	type InquiryAnswers,
	type InquiryForm
} from '@fionas/shared';
import { submissionCopy, type SubmissionFailure } from '$lib/inquiry-submission.js';
import {
	createInquiry,
	getInquiryForm,
	isOutcomeUnknown,
	isSubmissionKey,
	type InquiryReceipt
} from './commerce.js';

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
 * The page's options no longer match the catalog (`CATALOG_REVISION_STALE`, or a 422 naming an
 * offering that is unknown, disabled or unavailable): fetch the current form past any cache, fit
 * the answers to it and hand it back for review. Never resubmits. The reviewed form is a new logical
 * submission with a new token; that is safe because a refused attempt never consumes its key.
 */
async function refreshForReview(
	data: FormData,
	outcome: 'stale' | 'rejected',
	status: number
): Promise<SubmitResult> {
	const fresh = await getInquiryForm({ fresh: true });
	if (!fresh.ok || pricingContractProblem(fresh.data) !== null) {
		return { ok: false, status, failure: { outcome, formError: submissionCopy.staleWithoutForm } };
	}
	const form = fresh.data;
	const { answers, changed, unavailable, removed } = reconcileAnswers(
		form,
		answersFromFormData(form, data)
	);
	return {
		ok: false,
		status,
		failure: {
			outcome,
			answers,
			refreshedForm: form,
			reviewFields: labelsOf(form, changed),
			unavailableChoices: unavailable,
			removedChoices: removed,
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

	// Every failure below keeps this submission's token and revision unless it says otherwise.
	const failed = (
		status: number,
		outcome: SubmissionFailure['outcome'],
		extra: Partial<SubmissionFailure> = {}
	): SubmitResult => ({
		ok: false,
		status,
		failure: { outcome, submissionToken: token, catalogRevision: revision, ...extra }
	});

	// Retrying a submission whose outcome was already unknown: until something settles it (a receipt
	// or a definite refusal), it stays unknown, whatever stops this attempt.
	const unresolved = data.get('outcomeUnknown') === 'true';
	const stillUnknown = (answers?: InquiryAnswers): SubmitResult =>
		failed(503, 'ambiguous', {
			answers,
			formError: submissionCopy.ambiguous,
			restartToken: newSubmissionToken()
		});

	// The current form maps answers to the request (field keys → submission pointers). If it can't
	// be read, or can't produce pricingInputs, nothing has been sent yet.
	const current = await getInquiryForm();
	if (!current.ok || pricingContractProblem(current.data) !== null) {
		return unresolved
			? stillUnknown()
			: failed(503, 'unavailable', { formError: submissionCopy.unavailable });
	}
	const form = current.data;
	const answers = answersFromFormData(form, data);

	// The submit gate: complete answers, including the whole service configuration, or nothing is
	// sent. The request is pinned to the customer's revision, never silently to the current one, and
	// carries intent only (no prices or totals). When the catalog has moved on, option membership is
	// left to the backend: an earlier commit of this key replays, anything else is stale.
	const command = prepareInquiry(form, answers, { catalogRevision: revision });
	if (!command.ok) {
		if (command.reason === 'incompatible') {
			console.error(`[inquiry] cannot build POST /inquiries (${command.problem}); nothing sent`);
			return unresolved
				? stillUnknown(answers)
				: failed(503, 'unavailable', { answers, formError: submissionCopy.unavailable });
		}
		// Answers that no longer fit the current form's service questions: review, never a resubmit.
		// Unless an earlier delivery may have committed: then "not sent" would be untrue, so it stays
		// unknown (same key, frozen answers) until the customer deliberately changes them.
		if (revision !== form.catalogRevision) {
			return unresolved ? stillUnknown(answers) : refreshForReview(data, 'stale', 409);
		}
		return failed(422, 'invalid', { answers, errors: command.errors });
	}

	const result = await createInquiry(command.request, token);
	if (result.ok) return { ok: true, receipt: result.data };

	const { error } = result;
	if (error.kind === 'conflict' && error.code === 'CATALOG_REVISION_STALE') {
		return refreshForReview(data, 'stale', 409);
	}
	if (error.kind === 'conflict' && error.code === 'IDEMPOTENCY_KEY_REUSED') {
		// Correct key handling makes this rare: it means one token carried two different requests.
		console.warn(
			`[inquiry] Idempotency-Key ${token} was already used for a different request; not retrying. Check the submission-token lifecycle.`
		);
		return failed(409, 'key_reused', {
			answers,
			formError: submissionCopy.keyReused,
			restartToken: newSubmissionToken()
		});
	}
	if (error.status === 422 && error.violations.some((code) => CATALOG_STATE_VIOLATIONS.has(code))) {
		// Our page offered something the catalog won't take (out of date, or tampered with).
		console.warn(
			`[inquiry] POST /inquiries refused the options (${error.violations.join(', ')}); refreshing the form for review`
		);
		return refreshForReview(data, 'rejected', 422);
	}
	if (error.status === 400 || error.status === 404 || error.status === 422) {
		if (error.status === 400) console.warn('[inquiry] POST /inquiries rejected as malformed');
		return failed(422, 'rejected', { answers, formError: rejectionMessage(error) });
	}
	// Sent, but we can't tell whether it was recorded. Only the identical request under the same key
	// may follow; a deliberate change of answers is a new submission (`restartToken`).
	if (isOutcomeUnknown(error) || unresolved) return stillUnknown(answers);
	if (error.kind === 'service_auth') {
		// Our SERVICE identity was refused before anything was processed; the adapter has logged why
		// for the operator. The visitor sees the generic outage, never the auth failure.
		return failed(503, 'unavailable', { answers, formError: submissionCopy.unavailable });
	}
	console.error(`[inquiry] POST /inquiries failed unexpectedly (${error.status} ${error.code})`);
	return failed(502, 'server_error', { answers, formError: submissionCopy.serverError });
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
