import type { ApiError } from '@fionas/shared';

/**
 * The single chokepoint for every call to the commerce API. The browser never talks to the
 * backend: it has no CORS headers, its session cookie is host-only, and it only accepts a trusted
 * `Origin`. Server code (hooks, load functions, actions, `+server.ts`) calls through here; see
 * `docs/admin-architecture.md`.
 */
export type BackendConfig = {
	/** Commerce API base URL, no trailing slash. */
	baseUrl: string;
	/** The admin site's own origin, sent as `Origin` so the backend's trusted-origin check passes. */
	origin: string;
	fetch?: typeof fetch;
};

export type ApiResult<T> =
	| { ok: true; data: T; setCookies: string[]; status?: number }
	| { ok: false; error: ApiError; retryAfter: number | null };

export type RequestOptions = {
	method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	json?: unknown;
	/** The browser's `Cookie` header, forwarded so the backend can identify the session. */
	cookie?: string | null;
	/** Only the send capabilities below may carry a key; never arbitrary browser headers. */
	idempotencyKey?: string;
	/** Shorthand for `capability: 'conversationReply'`. */
	conversationReply?: boolean;
	/**
	 * A named, path-bound capability. Each allows exactly one POST route: the two staff email sends
	 * (which require an Idempotency-Key and wait for the provider), and the write-free financial
	 * email preview (which performs a provider thread lookup).
	 */
	capability?: Capability;
};

const TIMEOUT_MS = 8000;
type Capability = 'conversationReply' | 'financialEmailSend' | 'financialEmailPreview';
/**
 * The explicit Idempotency-Key allowlist. A lookup plus two bounded provider attempts can take 90s,
 * so the sends wait 100s; configure ingress for at least 110s (docs/admin-conversation.md).
 */
const CAPABILITIES: Record<Capability, { path: RegExp; timeout: number; key: boolean }> = {
	conversationReply: {
		path: /^\/staff\/requests\/[^/]+\/conversation\/replies$/,
		timeout: 100000,
		key: true
	},
	financialEmailSend: {
		path: /^\/staff\/requests\/[^/]+\/financial-emails$/,
		timeout: 100000,
		key: true
	},
	financialEmailPreview: {
		path: /^\/staff\/requests\/[^/]+\/financial-emails\/preview$/,
		timeout: 30000,
		key: false
	}
};
/**
 * Admin-local cookies (recovery pointers and sealed financial-email records) belong to this host
 * only. They are never forwarded: commerce receives the staff session and nothing else of ours.
 */
const LOCAL_COOKIE = /^(?:fionas_reply_intent|fionas_fe\d)$/;
export function forwardedCookie(cookie: string | null | undefined): string | null {
	if (!cookie) return null;
	const kept = cookie
		.split(';')
		.map((part) => part.trim())
		.filter((part) => part && !LOCAL_COOKIE.test(part.slice(0, part.indexOf('=')).trim()));
	return kept.length ? kept.join('; ') : null;
}

/** Seconds from a `Retry-After` header (the backend sends delta-seconds), or null. */
function parseRetryAfter(value: string | null): number | null {
	if (!value) return null;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

export async function request<T = null>(
	config: BackendConfig,
	path: string,
	{
		method = 'GET',
		json,
		cookie,
		idempotencyKey,
		conversationReply = false,
		capability = conversationReply ? 'conversationReply' : undefined
	}: RequestOptions = {}
): Promise<ApiResult<T>> {
	const allowed = capability ? CAPABILITIES[capability] : null;
	if (
		(capability && (!allowed || method !== 'POST' || !allowed.path.test(path))) ||
		(idempotencyKey !== undefined &&
			(!allowed?.key || !/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyKey)))
	) {
		throw new TypeError('Invalid reply transport options');
	}
	if (allowed?.key && idempotencyKey === undefined) throw new TypeError('Reply key required');
	const doFetch = config.fetch ?? fetch;
	const headers: Record<string, string> = {
		accept: 'application/json',
		origin: config.origin
	};
	if (json !== undefined) headers['content-type'] = 'application/json';
	const session = forwardedCookie(cookie);
	if (session) headers.cookie = session;
	if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

	let response: Response;
	try {
		response = await doFetch(`${config.baseUrl.replace(/\/+$/, '')}${path}`, {
			method,
			headers,
			body: json === undefined ? undefined : JSON.stringify(json),
			redirect: 'manual',
			signal: AbortSignal.timeout(allowed?.timeout ?? TIMEOUT_MS)
		});
	} catch {
		return {
			ok: false,
			retryAfter: null,
			error: {
				status: 503,
				code: 'unavailable',
				message: 'The service is unreachable',
				violations: []
			}
		};
	}

	if (response.ok) {
		const data = response.status === 204 ? null : await response.json().catch(() => null);
		return {
			ok: true,
			data: data as T,
			setCookies: response.headers.getSetCookie(),
			status: response.status
		};
	}

	const body = await response.json().catch(() => null);
	if (path === '/auth/login' && response.status === 403 && body?.code === 'forbidden') {
		// Operator hint only: a 403 on /auth/login almost always means this admin's origin is not in
		// the backend's trusted-origin list. Never log cookies or request bodies.
		console.error(
			`[backend] ${method} ${path} → 403 forbidden; is "${config.origin}" a trusted origin on the API?`
		);
	}
	return {
		ok: false,
		retryAfter: parseRetryAfter(response.headers.get('retry-after')),
		error: {
			status: response.status,
			code: typeof body?.code === 'string' ? body.code : 'internal_failure',
			message: typeof body?.message === 'string' ? body.message : 'The request failed',
			violations: Array.isArray(body?.violations)
				? body.violations.flatMap((v: { code?: unknown }) =>
						typeof v?.code === 'string' ? [v.code] : []
					)
				: []
		}
	};
}
