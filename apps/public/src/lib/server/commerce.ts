import { env } from '$env/dynamic/private';
import type {
	ApiError,
	CreateInquiryRequest,
	EstimatePreview,
	InquiryForm,
	PricingInputs
} from '@fionas/shared';

/*
 * Server-only client for the fionas-commerce API. The backend sends no CORS headers, so the
 * browser never talks to it directly: pages and endpoints call these helpers instead.
 *
 * The UI endpoints (/inquiry-form, /estimate-preview, POST /inquiries) require the trusted
 * server-side UI key as a Bearer token. It comes from COMMERCE_UI_API_KEY (private env, so
 * SvelteKit keeps it out of client bundles) and is never logged or sent to the browser.
 */

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

const TIMEOUT_MS = 8000;

const baseUrl = () => (env.COMMERCE_API_URL ?? 'http://localhost:8080').replace(/\/+$/, '');

const uiKey = () => env.COMMERCE_UI_API_KEY?.trim() || undefined;

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
	let response: Response;
	const key = uiKey();
	try {
		response = await fetch(`${baseUrl()}${path}`, {
			...init,
			headers: {
				accept: 'application/json',
				...(key ? { authorization: `Bearer ${key}` } : {}),
				...init?.headers
			},
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
	} catch {
		return {
			ok: false,
			error: {
				status: 503,
				code: 'unavailable',
				message: 'Commerce API unreachable',
				violations: []
			}
		};
	}

	if (response.status === 401 || response.status === 403) {
		// Visitors just see "unavailable"; the operator needs to know why.
		console.error(
			key
				? `[commerce] ${path} rejected the UI API key: check COMMERCE_UI_API_KEY in apps/public/.env`
				: `[commerce] ${path} needs a UI API key: set COMMERCE_UI_API_KEY in apps/public/.env`
		);
	}

	const body: unknown = await response.json().catch(() => null);
	if (response.ok) return { ok: true, data: body as T };

	const error = (body ?? {}) as {
		code?: string;
		message?: string;
		violations?: { code: string }[];
	};
	return {
		ok: false,
		error: {
			status: response.status,
			code: error.code ?? 'internal_failure',
			message: error.message ?? 'The request could not be completed',
			violations: (error.violations ?? []).map((v) => v.code)
		}
	};
}

const json = (body: unknown): RequestInit => ({
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body)
});

export const getInquiryForm = () => request<InquiryForm>('/inquiry-form');

export const previewEstimate = (pricingInputs: PricingInputs) =>
	request<EstimatePreview>('/estimate-preview', json(pricingInputs));

export const createInquiry = (inquiry: CreateInquiryRequest) =>
	request<{ id: string; createdAt: string }>('/inquiries', json(inquiry));
