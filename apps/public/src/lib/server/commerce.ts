import { env } from '$env/dynamic/private';
import {
	EXPECTED_DEFINITION_VERSION,
	isPricingField,
	pricingContractProblem,
	type ApiError,
	type CreateInquiryRequest,
	type InquiryForm,
	type PricingInputs
} from '@fionas/shared';
import { isEstimatePreview, isInquiryForm } from './commerce-shapes.js';

/*
 * Server-only client for the fionas-commerce API. The backend sends no CORS headers, so the
 * browser never talks to it directly: pages, form actions and endpoints call these helpers instead.
 * See docs/public-inquiry-submission.md.
 *
 * The UI endpoints (/inquiry-form, /estimate-preview, POST /inquiries) require the trusted
 * server-side UI key as a Bearer token. It comes from FIONAS_UI_API_KEY (the backend's own name for
 * it; private env, so SvelteKit keeps it out of client bundles) and is never logged, returned or
 * sent to the browser. The base URL is COMMERCE_API_URL, shared with the admin app.
 */

/**
 * How a call failed, for behavior (the stable backend `code` says which conflict or violation):
 * - `validation`: 400 / 422, a definite refusal; nothing was written
 * - `not_found`: 404 (catalog not initialized, or an unknown revision)
 * - `conflict`: 409 (`CATALOG_REVISION_STALE`, `IDEMPOTENCY_KEY_REUSED`, or the retryable `conflict`)
 * - `unauthorized`: 401 / 403, our credential was refused; nothing was written
 * - `server`: a 5xx answer
 * - `timeout`: no answer in time. For a POST the outcome is unknown: it may have committed
 * - `network`: the connection failed. For a POST the outcome is unknown too
 * - `unexpected`: an answer outside the contract (unreadable or wrongly shaped body, odd status).
 *   Never trusted: the caller fails closed
 */
export type CommerceFailureKind =
	| 'validation'
	| 'not_found'
	| 'conflict'
	| 'unauthorized'
	| 'server'
	| 'timeout'
	| 'network'
	| 'unexpected';

export type CommerceError = ApiError & { kind: CommerceFailureKind };

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: CommerceError };

/** What POST /inquiries answers (201): the public-safe identity of the recorded inquiry. */
export type InquiryReceipt = { id: string; createdAt: string };

const TIMEOUT_MS = 8000;

/** POST /inquiries tries at most this often, and only after an ambiguous or transient failure. */
const MAX_SUBMIT_ATTEMPTS = 2;
const RETRY_DELAY_MS = 250;

/** The `Idempotency-Key` format the backend accepts: opaque, 1–128 of [A-Za-z0-9_-]. UUIDs fit. */
const SUBMISSION_KEY = /^[A-Za-z0-9_-]{1,128}$/;

export const isSubmissionKey = (value: unknown): value is string =>
	typeof value === 'string' && SUBMISSION_KEY.test(value);

const baseUrl = () => (env.COMMERCE_API_URL ?? 'http://localhost:8080').replace(/\/+$/, '');

const uiKey = () => env.FIONAS_UI_API_KEY?.trim() || undefined;

type RequestOptions = {
	method?: 'GET' | 'POST';
	json?: unknown;
	headers?: Record<string, string>;
	/** Skip every cache between here and the backend (stale-catalog recovery). */
	fresh?: boolean;
};

const failure = (
	kind: CommerceFailureKind,
	status: number,
	code: string,
	message: string
): { ok: false; error: CommerceError } => ({
	ok: false,
	error: { kind, status, code, message, violations: [] }
});

function kindOf(status: number): CommerceFailureKind {
	if (status === 400 || status === 422) return 'validation';
	if (status === 404) return 'not_found';
	if (status === 409) return 'conflict';
	if (status === 401 || status === 403) return 'unauthorized';
	if (status >= 500) return 'server';
	return 'unexpected';
}

const isTimeout = (e: unknown) =>
	e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError');

async function request(
	path: string,
	{ method = 'GET', json, headers, fresh = false }: RequestOptions = {}
): Promise<ApiResult<unknown>> {
	const key = uiKey();
	let response: Response;
	try {
		response = await fetch(`${baseUrl()}${path}`, {
			method,
			headers: {
				accept: 'application/json',
				...(json === undefined ? {} : { 'content-type': 'application/json' }),
				...(fresh ? { 'cache-control': 'no-cache' } : {}),
				...headers,
				...(key ? { authorization: `Bearer ${key}` } : {})
			},
			body: json === undefined ? undefined : JSON.stringify(json),
			cache: fresh ? 'no-store' : undefined,
			redirect: 'manual',
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
	} catch (e) {
		// For a POST neither proves anything: the backend may have committed before we lost it.
		return isTimeout(e)
			? failure('timeout', 504, 'timeout', 'Commerce API did not answer in time')
			: failure('network', 503, 'unavailable', 'Commerce API unreachable');
	}

	if (response.status === 401 || response.status === 403) {
		// Visitors just see "unavailable"; the operator needs to know why. Never the key itself.
		console.error(
			key
				? `[commerce] ${path} rejected the UI API key: check FIONAS_UI_API_KEY in apps/public/.env`
				: `[commerce] ${path} needs a UI API key: set FIONAS_UI_API_KEY in apps/public/.env`
		);
	}

	let body: unknown = null;
	try {
		body = await response.json();
	} catch {
		// A success whose body was lost or garbled is as ambiguous as a dropped connection.
		if (response.ok) {
			return failure('unexpected', 502, 'bad_response', 'Unreadable commerce API response');
		}
	}
	if (response.ok) return { ok: true, data: body };

	const error = (body ?? {}) as { code?: unknown; message?: unknown; violations?: unknown };
	return {
		ok: false,
		error: {
			kind: kindOf(response.status),
			status: response.status,
			code: typeof error.code === 'string' ? error.code : 'internal_failure',
			message:
				typeof error.message === 'string' ? error.message : 'The request could not be completed',
			violations: Array.isArray(error.violations)
				? error.violations.flatMap((v: { code?: unknown }) =>
						typeof v?.code === 'string' ? [v.code] : []
					)
				: []
		}
	};
}

/** A 2xx is trusted only in its documented shape; anything else fails closed. */
function shaped<T>(
	result: ApiResult<unknown>,
	check: (body: unknown) => body is T,
	what: string
): ApiResult<T> {
	if (!result.ok) return result;
	if (check(result.data)) return { ok: true, data: result.data };
	console.error(`[commerce] ${what} returned a body outside the contract; not using it`);
	return failure('unexpected', 502, 'bad_response', `Unexpected ${what} response`);
}

const isReceipt = (body: unknown): body is InquiryReceipt =>
	typeof body === 'object' &&
	body !== null &&
	typeof (body as InquiryReceipt).id === 'string' &&
	typeof (body as InquiryReceipt).createdAt === 'string';

/**
 * Worth sending again with the same key: the request may or may not have been committed (network
 * failure, timeout, unreadable success), a gateway hiccup, or the backend's documented retryable
 * `conflict` (a concurrent request created the same customer first). Never a semantic 4xx. If the
 * retry fails the same way, the submission's outcome is still unknown (see `submitInquiry`).
 */
export const isOutcomeUnknown = (error: CommerceError) =>
	error.kind === 'timeout' ||
	error.kind === 'network' ||
	error.code === 'bad_response' ||
	(error.kind === 'conflict' && error.code === 'conflict') ||
	error.status === 502 ||
	error.status === 503 ||
	error.status === 504;

/**
 * GET /inquiry-form. Every call reaches the backend: nothing here caches the form, so a page view
 * always renders the current revision. `fresh` also tells any HTTP cache in between to revalidate
 * (the backend sends `private, max-age=60, must-revalidate`), for recovery from
 * `CATALOG_REVISION_STALE`.
 */
export async function getInquiryForm({ fresh = false }: { fresh?: boolean } = {}) {
	const result = shaped(
		await request('/inquiry-form', { fresh }),
		isInquiryForm,
		'GET /inquiry-form'
	);
	if (result.ok) checkDefinition(result.data);
	return result;
}

const warned = new Set<string>();
const warnOnce = (message: string) => {
	if (warned.has(message)) return;
	warned.add(message);
	console.warn(message);
};

/**
 * The form is self-describing, so a newer question definition still renders; the operator should
 * know when it differs from what this UI was built against. Logged once each, never shown to
 * customers. A form that can't produce `pricingInputs` at all is refused by the callers.
 */
function checkDefinition(form: InquiryForm) {
	if (form.definitionVersion !== EXPECTED_DEFINITION_VERSION) {
		warnOnce(
			`[commerce] GET /inquiry-form returned definitionVersion ${form.definitionVersion}; this UI expects ${EXPECTED_DEFINITION_VERSION}`
		);
	}
	for (const section of form.sections) {
		if (section.optional && section.fields.some(isPricingField)) {
			warnOnce(
				`[commerce] GET /inquiry-form marks section "${section.key}" optional, but POST /inquiries requires pricingInputs; the UI requires it`
			);
		}
	}
	const problem = pricingContractProblem(form);
	if (problem) {
		warnOnce(
			`[commerce] GET /inquiry-form cannot produce pricingInputs (${problem}); inquiries are off`
		);
	}
}

/** POST /estimate-preview: authoritative pricing that writes nothing. */
export async function previewEstimate(pricingInputs: PricingInputs) {
	return shaped(
		await request('/estimate-preview', { method: 'POST', json: pricingInputs }),
		isEstimatePreview,
		'POST /estimate-preview'
	);
}

/**
 * POST /inquiries with the logical submission's `Idempotency-Key`. The caller owns the key: it
 * names one visible submission and must be the same for every delivery of it. A failure that
 * leaves the outcome unknown is retried once here with that same key and the same body, so a
 * commit whose response was lost comes back as the original receipt rather than a second inquiry.
 */
export async function createInquiry(
	inquiry: CreateInquiryRequest,
	idempotencyKey: string
): Promise<ApiResult<InquiryReceipt>> {
	if (!isSubmissionKey(idempotencyKey)) {
		throw new Error('createInquiry needs the logical submission key ([A-Za-z0-9_-]{1,128})');
	}
	// The type already says so; this guards untyped callers. There is no contact-only inquiry.
	if (typeof inquiry?.pricingInputs !== 'object' || inquiry.pricingInputs === null) {
		throw new Error('createInquiry needs pricingInputs: every inquiry is configured service');
	}

	const send = async (): Promise<ApiResult<InquiryReceipt>> => {
		const result = await request('/inquiries', {
			method: 'POST',
			json: inquiry,
			headers: { 'idempotency-key': idempotencyKey }
		});
		if (!result.ok) return result;
		if (!isReceipt(result.data)) {
			return failure('unexpected', 502, 'bad_response', 'Unexpected receipt shape');
		}
		return { ok: true, data: { id: result.data.id, createdAt: result.data.createdAt } };
	};

	let result = await send();
	for (let attempt = 1; attempt < MAX_SUBMIT_ATTEMPTS; attempt++) {
		if (result.ok || !isOutcomeUnknown(result.error)) break;
		console.warn(
			`[commerce] POST /inquiries attempt ${attempt} failed (${result.error.status} ${result.error.code}); retrying with the same Idempotency-Key`
		);
		await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
		result = await send();
	}
	return result;
}
