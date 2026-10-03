import type { Cookies } from '@sveltejs/kit';
import {
	answersFromFormData,
	CATALOG_STATE_VIOLATIONS,
	describeViolation,
	prepareInquiry,
	pricingContractProblem,
	reconcileAnswers,
	type ApiError,
	type CreateInquiryRequest,
	type InquiryAnswers,
	type InquiryForm
} from '@fionas/shared';
import { submissionCopy, type SubmissionFailure } from '$lib/inquiry-submission.js';
import {
	createInquiry,
	getInquiryForm,
	isSubmissionKey,
	type CommerceError,
	type InquiryReceipt
} from './commerce.js';
import { isCreateInquiryRequest } from './commerce-shapes.js';

/*
 * The /book submission flow between the browser and fionas-commerce. The browser posts the
 * customer's answers plus two non-secret hidden values: the logical submission token (sent to the
 * backend as `Idempotency-Key`) and the catalog revision the answers were given against. This
 * module never mints a key for an attempt: the token arrives with the form and is reused for every
 * delivery and retry of that submission, and one key always carries one command: after an unknown
 * outcome the delivered request travels with the page (`replay`) and is resent unchanged. See
 * docs/public-inquiry-submission.md.
 */

/** A new opaque token naming one logical submission. Not a credential. */
export const newSubmissionToken = (): string => crypto.randomUUID();

/** A replayed request is a few hundred bytes; anything far larger isn't one. */
const MAX_REPLAY_LENGTH = 32_768;

export type SubmitResult =
	| { ok: true; receipt: InquiryReceipt; firstName: string | null }
	| { ok: false; status: number; failure: SubmissionFailure };

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

/** Parses the posted replay snapshot: the exact request shape, or nothing. Never trusted unchecked. */
export function parseReplay(raw: unknown): CreateInquiryRequest | null {
	if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_REPLAY_LENGTH) return null;
	try {
		const value: unknown = JSON.parse(raw);
		return isCreateInquiryRequest(value) ? value : null;
	} catch {
		return null;
	}
}

type Failed = (
	status: number,
	outcome: SubmissionFailure['outcome'],
	extra?: Partial<SubmissionFailure>
) => SubmitResult;

/** Delivered, outcome unknown: the next try must be this very command under the same key. */
const stillUnknown = (failed: Failed, request: CreateInquiryRequest, answers?: InquiryAnswers) =>
	failed(503, 'ambiguous', {
		answers,
		replay: { request },
		formError: submissionCopy.ambiguous,
		restartToken: newSubmissionToken()
	});

/**
 * What a refused or failed delivery of `request` under `token` means for the visitor. Shared by the
 * first delivery and replays: only a receipt or a definite refusal settles a submission; anything
 * else keeps it unknown, with the same command to resend. `answers` are for display only.
 */
async function settle(
	error: CommerceError,
	{ data, token, request, failed, replaying }: Delivery,
	answers: () => Promise<InquiryAnswers | undefined>
): Promise<SubmitResult> {
	if (error.kind === 'conflict' && error.code === 'CATALOG_REVISION_STALE') {
		return refreshForReview(data, 'stale', 409);
	}
	if (error.kind === 'conflict' && error.code === 'IDEMPOTENCY_KEY_REUSED') {
		// Correct key handling makes this rare: it means one token carried two different requests.
		console.warn(
			`[inquiry] Idempotency-Key ${token} was already used for a different request; not retrying. Check the submission-token lifecycle.`
		);
		return failed(409, 'key_reused', {
			answers: await answers(),
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
		return failed(422, 'rejected', {
			answers: await answers(),
			formError: rejectionMessage(error)
		});
	}
	// Our SERVICE identity was refused before anything was processed (the adapter has logged why for
	// the operator): nothing was sent, so the visitor sees the generic outage, never the auth
	// failure. Unless this is a replay: then the earlier delivery's outcome is still open.
	if (error.kind === 'service_auth' && !replaying) {
		return failed(503, 'unavailable', {
			answers: await answers(),
			formError: submissionCopy.unavailable
		});
	}
	// Anything else (timeouts, lost or garbled answers, any 5xx, statuses outside the contract) may
	// have been recorded. Only this same command under the same key may follow; a deliberate change
	// of answers is a new submission (`restartToken`).
	console.warn(
		`[inquiry] POST /inquiries outcome unknown (${error.status} ${error.code}); keeping the request for an identical retry`
	);
	return stillUnknown(failed, request, await answers());
}

type Delivery = {
	data: FormData;
	token: string;
	request: CreateInquiryRequest;
	failed: Failed;
	/** Resending the snapshot of a submission whose outcome was unknown. */
	replaying: boolean;
};

/**
 * Answers to show again after a replay (the no-JavaScript page has nothing else to render). Read
 * against the current form only for display, after sending: never used to build a request.
 */
async function displayAnswers(data: FormData): Promise<InquiryAnswers | undefined> {
	const current = await getInquiryForm();
	return current.ok ? answersFromFormData(current.data, data) : undefined;
}

/** Runs one delivery of a /book submission. */
export async function submitInquiry(data: FormData): Promise<SubmitResult> {
	// "Send as a new request" (after IDEMPOTENCY_KEY_REUSED) deliberately supplies a new key: a new
	// submission, whatever else was posted with it.
	const restart = data.get('restartToken');
	const restarting = typeof restart === 'string' && restart !== '';
	const token = restarting ? restart : data.get('submissionToken');
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
	const failed =
		(catalogRevision: number): Failed =>
		(status, outcome, extra = {}) => ({
			ok: false,
			status,
			failure: { outcome, submissionToken: token, catalogRevision, ...extra }
		});

	// Retrying a submission whose outcome is unknown: resend the command it delivered, exactly.
	if (!restarting && data.get('outcomeUnknown') === 'true') {
		return replaySubmission(data, token, failed);
	}

	// The current form maps answers to the request (field keys → submission pointers). If it can't
	// be read, or can't produce pricingInputs, nothing has been sent yet.
	const current = await getInquiryForm();
	if (!current.ok || pricingContractProblem(current.data) !== null) {
		return failed(revision)(503, 'unavailable', { formError: submissionCopy.unavailable });
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
			return failed(revision)(503, 'unavailable', {
				answers,
				formError: submissionCopy.unavailable
			});
		}
		// Answers that no longer fit the current form's service questions: review, never a resubmit.
		if (revision !== form.catalogRevision) return refreshForReview(data, 'stale', 409);
		return failed(revision)(422, 'invalid', { answers, errors: command.errors });
	}

	// This request is the submission's one command from here on: if its outcome becomes unknown, it
	// is what goes back to the page (`replay`) and what a retry resends.
	const request = command.request;
	const result = await createInquiry(request, token);
	if (result.ok) return { ok: true, receipt: result.data, firstName: firstNameOf(request.name) };
	return settle(
		result.error,
		{ data, token, request, failed: failed(revision), replaying: false },
		async () => answers
	);
}

/**
 * "Try sending again" after an unknown outcome. The posted snapshot is the request that was
 * delivered under this key; it is checked for its exact transport shape and sent unchanged, never
 * rebuilt from today's form (which may have changed since). The backend then settles it: the
 * original receipt if it had committed, `CATALOG_REVISION_STALE` (review, new key) if it hadn't and
 * the catalog moved on, or a normal answer. Without a usable snapshot nothing is sent.
 */
async function replaySubmission(
	data: FormData,
	token: string,
	failed: (catalogRevision: number) => Failed
): Promise<SubmitResult> {
	const request = parseReplay(data.get('replayRequest'));
	if (!request) {
		console.warn('[inquiry] unresolved /book retry without a usable replay request; nothing sent');
		return failed(Number(data.get('catalogRevision')))(400, 'ambiguous', {
			answers: await displayAnswers(data),
			formError: submissionCopy.replayUnusable,
			restartToken: newSubmissionToken()
		});
	}
	const result = await createInquiry(request, token);
	if (result.ok) return { ok: true, receipt: result.data, firstName: firstNameOf(request.name) };
	return settle(
		result.error,
		{
			data,
			token,
			request,
			failed: failed(request.pricingInputs.catalogRevision),
			replaying: true
		},
		() => displayAnswers(data)
	);
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
