import { env } from '$env/dynamic/private';

const DEFAULT_RESPONSE_LIMIT_BYTES = 1_048_576;
const TRACKING_TOKEN_MIN_LENGTH = 16;

export type PresentationServiceFailureKind = 'misconfigured' | 'timeout' | 'network';

export type PresentationServiceResult =
	{ ok: true; response: Response } | { ok: false; kind: PresentationServiceFailureKind };

type PresentationServiceRequestOptions = {
	operation: string;
	method?: 'GET' | 'POST';
	body?: unknown;
	timeoutMs: number;
	/** Gallery reads and tracking writes both require a bearer. Callers that require one
	 * must confirm it's configured (see `presentationServiceTrackingToken`) before calling
	 * — an authenticated call is never attempted without it. */
	bearerToken?: string;
};

function presentationServiceBaseUrl(): URL | null {
	const configured = env.PRESENTATION_SERVICE_BASE_URL?.trim();
	if (!configured) return null;
	try {
		const url = new URL(configured);
		if (
			!['http:', 'https:'].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			!['', '/'].includes(url.pathname)
		) {
			return null;
		}
		return url;
	} catch {
		return null;
	}
}

export function presentationServiceAccountId(): string | null {
	const value = env.PRESENTATION_SERVICE_ACCOUNT_ID?.trim();
	return value ? value : null;
}

export function presentationServiceGalleryName(): string | null {
	const value = env.PRESENTATION_SERVICE_GALLERY_NAME?.trim();
	return value ? value : null;
}

export function presentationServiceTrackingToken(): string | null {
	const value = env.PRESENTATION_SERVICE_TRACKING_TOKEN?.trim();
	return value && value.length >= TRACKING_TOKEN_MIN_LENGTH ? value : null;
}

function timedOut(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'name' in error &&
		typeof error.name === 'string' &&
		['AbortError', 'TimeoutError'].includes(error.name)
	);
}

export async function requestPresentationService(
	path: `/${string}`,
	options: PresentationServiceRequestOptions
): Promise<PresentationServiceResult> {
	const baseUrl = presentationServiceBaseUrl();
	if (!baseUrl) {
		console.error('Presentation-service request is not configured', {
			operation: options.operation
		});
		return { ok: false, kind: 'misconfigured' };
	}

	const startedAt = performance.now();
	try {
		const response = await fetch(new URL(path, baseUrl), {
			method: options.method ?? 'GET',
			cache: 'no-store',
			redirect: 'error',
			headers: {
				accept: 'application/json',
				...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
				...(options.body === undefined ? {} : { 'content-type': 'application/json' })
			},
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: AbortSignal.timeout(options.timeoutMs)
		});
		if (!response.ok) {
			console.warn('Presentation-service request returned a non-success status', {
				operation: options.operation,
				status: response.status,
				durationMs: Math.round(performance.now() - startedAt)
			});
		}
		return { ok: true, response };
	} catch (error) {
		const kind = timedOut(error) ? 'timeout' : 'network';
		console.error('Presentation-service request failed', {
			operation: options.operation,
			kind,
			durationMs: Math.round(performance.now() - startedAt)
		});
		return { ok: false, kind };
	}
}

export async function readPresentationServiceJson(
	response: Response,
	maxBytes = DEFAULT_RESPONSE_LIMIT_BYTES
): Promise<unknown | null> {
	const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
	if (mediaType !== 'application/json') return null;

	const declaredLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;

	try {
		const reader = response.body?.getReader();
		if (!reader) return null;
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > maxBytes) {
					await reader.cancel();
					return null;
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
}
