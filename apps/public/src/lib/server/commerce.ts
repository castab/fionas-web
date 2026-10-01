import { env } from '$env/dynamic/private';
import {
	EXPECTED_DEFINITION_VERSION,
	pricingContractProblem,
	type ApiError,
	type CreateInquiryRequest,
	type InquiryForm,
	type PricingInputs
} from '@fionas/shared';
import { isEstimatePreview, isInquiryForm } from './commerce-shapes.js';
import { createServiceTokenSource } from './service-auth.js';

/*
 * Server-only client for the fionas-commerce API. The backend sends no CORS headers, so the
 * browser never talks to it directly: pages, form actions and endpoints call these helpers instead.
 * See docs/public-inquiry-submission.md.
 *
 * The public endpoints (/inquiry-form, /estimate-preview, POST /inquiries) are called as
 * SERVICE:fionas-web, with a short-lived access token from `service-auth.ts` sent as
 * `Authorization: Bearer`. The service credential it is bought with comes from private env
 * (COMMERCE_SERVICE_ID, COMMERCE_SERVICE_CREDENTIAL); neither it nor the token is ever logged,
 * returned or sent to the browser. The base URL is COMMERCE_API_URL, shared with the admin app.
 */

/**
 * How a call failed, for behavior (the stable backend `code` says which conflict or violation):
 * - `validation`: 400 / 422, a definite refusal; nothing was written
 * - `not_found`: 404 (catalog not initialized, or an unknown revision)
 * - `conflict`: 409 (`CATALOG_REVISION_STALE`, `IDEMPOTENCY_KEY_REUSED`, or the retryable `conflict`)
 * - `service_auth`: our SERVICE identity couldn't be used: no token could be obtained (credential
 *   missing or refused, token endpoint unreachable or answering outside the contract), a fresh
 *   token was still refused (401), or the service lacks the permission (403). The protected request
 *   was not processed. An operator problem: visitors see "unavailable", never why
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
	| 'service_auth'
	| 'server'
	| 'timeout'
	| 'network'
	| 'unexpected';

export type CommerceError = ApiError & { kind: CommerceFailureKind };

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: CommerceError };

/** What POST /inquiries answers (201): the public-safe identity of the recorded inquiry. */
export type InquiryReceipt = { id: string; createdAt: string };

export type CommerceClientConfig = {
	/** fionas-commerce base URL. */
	baseUrl: string;
	/** UUID of SERVICE:fionas-web. Checked when the backend is first needed, not at startup. */
	serviceId?: string;
	/** Its credential secret. */
	credential?: string;
	/** Defaults to the global `fetch`, looked up per call. */
	fetch?: typeof fetch;
	/** Defaults to `Date.now`. */
	now?: () => number;
	/** Pause before `createInquiry`'s one same-key retry. */
	retryDelayMs?: number;
};

const TIMEOUT_MS = 8000;

/** POST /inquiries tries at most this often, and only after an ambiguous or transient failure. */
const MAX_SUBMIT_ATTEMPTS = 2;
const RETRY_DELAY_MS = 250;

/** The `Idempotency-Key` format the backend accepts: opaque, 1–128 of [A-Za-z0-9_-]. UUIDs fit. */
const SUBMISSION_KEY = /^[A-Za-z0-9_-]{1,128}$/;

export const isSubmissionKey = (value: unknown): value is string =>
	typeof value === 'string' && SUBMISSION_KEY.test(value);

type RequestOptions = {
	method?: 'GET' | 'POST';
	json?: unknown;
	headers?: Record<string, string>;
	/** Skip every cache between here and the backend (stale-catalog recovery). */
	fresh?: boolean;
	/** The fionas.web permission the call needs, named in the operator's log on a 403. */
	permission: string;
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

/** Visitors get the generic outage; the reason is in the server log. */
const serviceUnavailable = () =>
	failure('service_auth', 503, 'unavailable', 'Commerce service authentication unavailable');

function kindOf(status: number): CommerceFailureKind {
	if (status === 400 || status === 422) return 'validation';
	if (status === 404) return 'not_found';
	if (status === 409) return 'conflict';
	if (status >= 500) return 'server';
	return 'unexpected';
}

const isTimeout = (e: unknown) =>
	e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError');

/** Frees the connection of a response whose body we won't read. */
const discard = (response: Response) => response.body?.cancel().catch(() => {});

async function decode(response: Response): Promise<ApiResult<unknown>> {
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
 * `conflict` (a concurrent request created the same customer first). Never a semantic 4xx, and
 * never a service-auth failure (nothing was processed: that's an outage). If the retry fails the
 * same way, the submission's outcome is still unknown (see `submitInquiry`).
 */
export const isOutcomeUnknown = (error: CommerceError) =>
	error.kind !== 'service_auth' &&
	(error.kind === 'timeout' ||
		error.kind === 'network' ||
		error.code === 'bad_response' ||
		(error.kind === 'conflict' && error.code === 'conflict') ||
		error.status === 502 ||
		error.status === 503 ||
		error.status === 504);

const warned = new Set<string>();
const warnOnce = (message: string) => {
	if (warned.has(message)) return;
	warned.add(message);
	console.warn(message);
};

/**
 * The form is self-describing, so a newer question definition still renders; the operator should
 * know when it differs from what this UI was built against. Logged once each, never shown to
 * customers. A form incompatible with POST /inquiries (`pricingContractProblem`, such as an optional
 * service section) is refused by the callers: no form is offered and nothing is sent.
 */
function checkDefinition(form: InquiryForm) {
	if (form.definitionVersion !== EXPECTED_DEFINITION_VERSION) {
		warnOnce(
			`[commerce] GET /inquiry-form returned definitionVersion ${form.definitionVersion}; this UI expects ${EXPECTED_DEFINITION_VERSION}`
		);
	}
	const problem = pricingContractProblem(form);
	if (problem) {
		warnOnce(
			`[commerce] GET /inquiry-form is incompatible with POST /inquiries (${problem}); inquiries are off`
		);
	}
}

/**
 * A client authenticated as SERVICE:fionas-web. Every protected call takes the current access token
 * (obtained lazily, cached in memory, refreshed early, one exchange at a time) and, if the backend
 * answers 401, drops that token, obtains another and repeats the identical request exactly once.
 * A 403 is never retried: the service is authenticated but not granted the permission, and a new
 * token carries no new grants (the backend resolves them live).
 */
export function createCommerceClient(config: CommerceClientConfig) {
	const baseUrl = config.baseUrl.replace(/\/+$/, '');
	const doFetch: typeof fetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
	const retryDelayMs = config.retryDelayMs ?? RETRY_DELAY_MS;
	const tokens = createServiceTokenSource({
		baseUrl,
		serviceId: config.serviceId,
		credential: config.credential,
		fetch: doFetch,
		now: config.now ?? Date.now
	});

	async function request(
		path: string,
		{ method = 'GET', json, headers, fresh = false, permission }: RequestOptions
	): Promise<ApiResult<unknown>> {
		// Built once: an authentication retry repeats exactly these headers and bytes, Idempotency-Key
		// included; only the bearer token differs.
		const body = json === undefined ? undefined : JSON.stringify(json);
		const fixed: Record<string, string> = {
			accept: 'application/json',
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
			...(fresh ? { 'cache-control': 'no-cache' } : {}),
			...headers
		};

		const send = async (accessToken: string): Promise<Response | ApiResult<never>> => {
			try {
				return await doFetch(`${baseUrl}${path}`, {
					method,
					headers: { ...fixed, authorization: `Bearer ${accessToken}` },
					body,
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
		};

		let token = await tokens.token();
		if (!token.ok) return serviceUnavailable();
		let response = await send(token.accessToken);
		if (!(response instanceof Response)) return response;

		if (response.status === 401) {
			// Refused before processing (expired, revoked, or the backend's key rotated): one retry.
			await discard(response);
			tokens.invalidate(token.accessToken);
			token = await tokens.token();
			if (!token.ok) return serviceUnavailable();
			response = await send(token.accessToken);
			if (!(response instanceof Response)) return response;
		}

		if (response.status === 401 || response.status === 403) {
			await discard(response);
			console.error(
				response.status === 403
					? `[commerce] ${method} ${path} → 403; check fionas-web service permissions (needs ${permission})`
					: `[commerce] ${method} ${path} → 401 with a fresh service token; check SERVICE:fionas-web is active`
			);
			return serviceUnavailable();
		}
		return decode(response);
	}

	/**
	 * GET /inquiry-form. Every call reaches the backend: nothing here caches the form, so a page view
	 * always renders the current revision. `fresh` also tells any HTTP cache in between to revalidate
	 * (the backend sends `private, max-age=60, must-revalidate`), for recovery from
	 * `CATALOG_REVISION_STALE`.
	 */
	async function getInquiryForm({ fresh = false }: { fresh?: boolean } = {}) {
		const result = shaped(
			await request('/inquiry-form', { fresh, permission: 'fionas.inquiry-form.read' }),
			isInquiryForm,
			'GET /inquiry-form'
		);
		if (result.ok) checkDefinition(result.data);
		return result;
	}

	/** POST /estimate-preview: authoritative pricing that writes nothing. */
	async function previewEstimate(pricingInputs: PricingInputs) {
		return shaped(
			await request('/estimate-preview', {
				method: 'POST',
				json: pricingInputs,
				permission: 'fionas.estimate-preview.create'
			}),
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
	async function createInquiry(
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
				headers: { 'idempotency-key': idempotencyKey },
				permission: 'fionas.inquiries.create'
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
			await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
			const retry = await send();
			// A retry that never reached the backend settles nothing: the first outcome stays unknown.
			result = !retry.ok && retry.error.kind === 'service_auth' ? result : retry;
		}
		return result;
	}

	return { getInquiryForm, previewEstimate, createInquiry };
}

export type CommerceClient = ReturnType<typeof createCommerceClient>;

type EnvConfig = { baseUrl: string; serviceId?: string; credential?: string };

let shared: { config: EnvConfig; client: CommerceClient } | null = null;

/**
 * This process's client, built from private env when first needed (so the marketing site starts
 * without service credentials) and rebuilt if that configuration changes. One client means one
 * in-memory token per process.
 */
function commerce(): CommerceClient {
	const config: EnvConfig = {
		baseUrl: env.COMMERCE_API_URL || 'http://localhost:8080',
		serviceId: env.COMMERCE_SERVICE_ID?.trim() || undefined,
		credential: env.COMMERCE_SERVICE_CREDENTIAL?.trim() || undefined
	};
	if (
		!shared ||
		shared.config.baseUrl !== config.baseUrl ||
		shared.config.serviceId !== config.serviceId ||
		shared.config.credential !== config.credential
	) {
		shared = { config, client: createCommerceClient(config) };
	}
	return shared.client;
}

/** Drops this process's client and its cached token (tests start from a clean slate with it). */
export function resetCommerceClient(): void {
	shared = null;
}

export const getInquiryForm: CommerceClient['getInquiryForm'] = (options) =>
	commerce().getInquiryForm(options);

export const previewEstimate: CommerceClient['previewEstimate'] = (pricingInputs) =>
	commerce().previewEstimate(pricingInputs);

export const createInquiry: CommerceClient['createInquiry'] = (inquiry, idempotencyKey) =>
	commerce().createInquiry(inquiry, idempotencyKey);
