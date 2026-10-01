import { env } from '$env/dynamic/private';
import {
	EXPECTED_DEFINITION_VERSION,
	type ApiError,
	type CreateInquiryRequest,
	type EstimatePreview,
	type InquiryForm,
	type PricingInputs
} from '@fionas/shared';

/*
 * Server-only client for the fionas-commerce API. The backend sends no CORS headers, so the
 * browser never talks to it directly: pages, form actions and endpoints call these helpers instead.
 * See docs/public-inquiry-submission.md.
 *
 * The UI endpoints (/inquiry-form, /estimate-preview, POST /inquiries) require the trusted
 * server-side UI key as a Bearer token. It comes from COMMERCE_UI_API_KEY (private env, so
 * SvelteKit keeps it out of client bundles) and is never logged, returned or sent to the browser.
 */

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

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

const uiKey = () => env.COMMERCE_UI_API_KEY?.trim() || undefined;

type RequestOptions = {
	method?: 'GET' | 'POST';
	json?: unknown;
	headers?: Record<string, string>;
	/** Skip every cache between here and the backend (stale-catalog recovery). */
	fresh?: boolean;
};

const failure = (
	status: number,
	code: string,
	message: string
): { ok: false; error: ApiError } => ({
	ok: false,
	error: { status, code, message, violations: [] }
});

async function request<T>(
	path: string,
	{ method = 'GET', json, headers, fresh = false }: RequestOptions = {}
): Promise<ApiResult<T>> {
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
	} catch {
		// Refused, reset or timed out. For a POST this proves nothing: the backend may have committed.
		return failure(503, 'unavailable', 'Commerce API unreachable');
	}

	if (response.status === 401 || response.status === 403) {
		// Visitors just see "unavailable"; the operator needs to know why.
		console.error(
			key
				? `[commerce] ${path} rejected the UI API key: check COMMERCE_UI_API_KEY in apps/public/.env`
				: `[commerce] ${path} needs a UI API key: set COMMERCE_UI_API_KEY in apps/public/.env`
		);
	}

	let body: unknown = null;
	try {
		body = await response.json();
	} catch {
		// A success whose body was lost or garbled is as ambiguous as a dropped connection.
		if (response.ok) return failure(502, 'bad_response', 'Unreadable commerce API response');
	}
	if (response.ok) return { ok: true, data: body as T };

	const error = (body ?? {}) as { code?: unknown; message?: unknown; violations?: unknown };
	return {
		ok: false,
		error: {
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
export const isOutcomeUnknown = (error: ApiError) =>
	error.code === 'unavailable' ||
	error.code === 'bad_response' ||
	error.code === 'conflict' ||
	error.status === 502 ||
	error.status === 503 ||
	error.status === 504;

/**
 * GET /inquiry-form. Every call reaches the backend: nothing here caches the form. `fresh` also
 * tells any HTTP cache in between to revalidate, for recovery from `CATALOG_REVISION_STALE`.
 */
export async function getInquiryForm({ fresh = false }: { fresh?: boolean } = {}) {
	const result = await request<InquiryForm>('/inquiry-form', { fresh });
	if (result.ok) warnOnDefinitionVersion(result.data.definitionVersion);
	return result;
}

let warnedVersion: number | null = null;

/**
 * The form is self-describing, so a newer question definition still renders; the operator should
 * know the UI was built against another version. Logged once per version, never shown to customers.
 */
function warnOnDefinitionVersion(version: number) {
	if (version === EXPECTED_DEFINITION_VERSION || version === warnedVersion) return;
	warnedVersion = version;
	console.warn(
		`[commerce] GET /inquiry-form returned definitionVersion ${version}; this UI expects ${EXPECTED_DEFINITION_VERSION}`
	);
}

export const previewEstimate = (pricingInputs: PricingInputs) =>
	request<EstimatePreview>('/estimate-preview', { method: 'POST', json: pricingInputs });

/**
 * POST /inquiries with the logical submission's `Idempotency-Key`. The caller owns the key: it
 * names one visible submission and must be the same for every delivery of it. A failure that
 * leaves the outcome unknown is retried once here with that same key, so a commit whose response
 * was lost comes back as the original receipt rather than a second inquiry.
 */
export async function createInquiry(
	inquiry: CreateInquiryRequest,
	idempotencyKey: string
): Promise<ApiResult<InquiryReceipt>> {
	if (!isSubmissionKey(idempotencyKey)) {
		throw new Error('createInquiry needs the logical submission key ([A-Za-z0-9_-]{1,128})');
	}

	const send = async (): Promise<ApiResult<InquiryReceipt>> => {
		const result = await request<unknown>('/inquiries', {
			method: 'POST',
			json: inquiry,
			headers: { 'idempotency-key': idempotencyKey }
		});
		if (!result.ok) return result;
		if (!isReceipt(result.data)) return failure(502, 'bad_response', 'Unexpected receipt shape');
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
