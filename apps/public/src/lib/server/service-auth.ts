/*
 * The public app's SERVICE identity at fionas-commerce (SERVICE:fionas-web, role fionas.web).
 *
 * Three secrets are involved and they are never interchangeable:
 * - the backend's token signing key: fionas-commerce's own, never given to this app;
 * - the service credential (`serviceId` + secret): long-lived, from private deployment env
 *   (COMMERCE_SERVICE_ID / COMMERCE_SERVICE_CREDENTIAL), exchanged at POST /auth/service/token;
 * - the access token it buys: short-lived, held here in memory only and sent as
 *   `Authorization: Bearer` by `commerce.ts`.
 * None of them ever reaches the browser, a cookie, a log line or page data. Each server process
 * keeps its own token; nothing is shared or persisted.
 *
 * The exchange costs the backend a memory-hard Argon2 verification, so tokens are reused until
 * shortly before they expire, concurrent requests that find no usable token share a single
 * exchange, and after a failed exchange no other is attempted for a while (see `failureDelay`).
 */

export type ServiceTokenSourceConfig = {
	/** fionas-commerce base URL, no trailing slash. */
	baseUrl: string;
	/** UUID of SERVICE:fionas-web; validated lazily, so the marketing site runs without it. */
	serviceId: string | undefined;
	/** The opaque credential secret issued for that service. */
	credential: string | undefined;
	fetch: typeof fetch;
	/** Milliseconds since the epoch; injected so tests can move time. */
	now: () => number;
	timeoutMs?: number;
};

/** A token to send, or none: the reason has been logged for the operator, never for visitors. */
export type ServiceToken = { ok: true; accessToken: string } | { ok: false };

export type ServiceTokenSource = {
	/** The cached token while it is fresh; otherwise one shared exchange for a new one. */
	token(): Promise<ServiceToken>;
	/**
	 * Forgets `accessToken` after the backend refused it, but only if it is still the cached one: a
	 * newer token another request already installed is kept.
	 */
	invalidate(accessToken: string): void;
};

type CachedToken = { accessToken: string; expiresAt: number; refreshAt: number };

const TIMEOUT_MS = 8000;
const MIN_SKEW_MS = 1000;
const MAX_SKEW_MS = 60_000;

/** After a failed exchange: 5 s, then 10, 20, 40, and at most 60 s between attempts. */
const BASE_FAILURE_DELAY_MS = 5000;
const MAX_FAILURE_DELAY_MS = 60_000;
/** The longest `Retry-After` honored on a 429 or 503 from the token endpoint. */
const MAX_RETRY_AFTER_MS = 300_000;

export const failureDelay = (consecutiveFailures: number): number =>
	Math.min(MAX_FAILURE_DELAY_MS, BASE_FAILURE_DELAY_MS * 2 ** Math.max(0, consecutiveFailures - 1));

/** A `Retry-After` of whole seconds (the HTTP-date form is not used here), bounded; else null. */
function retryAfterMs(response: Response): number | null {
	if (response.status !== 429 && response.status !== 503) return null;
	const value = response.headers.get('retry-after')?.trim() ?? '';
	if (!/^\d+$/.test(value)) return null;
	return Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, Number(value) * 1000));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How long before expiry a token is replaced: a tenth of its lifetime, at least a second, at most a
 * minute, and never more than half the lifetime. A 15-minute token is replaced a minute early; a
 * 10-second test token a second early, so it is never "about to expire" from the moment it arrives.
 */
export const refreshSkew = (lifetimeMs: number): number =>
	Math.min(MAX_SKEW_MS, Math.max(MIN_SKEW_MS, lifetimeMs / 10), lifetimeMs / 2);

type TokenResponse = { accessToken: string; expiresIn: number };

/** POST /auth/service/token's documented 200 body. Anything else is unusable. */
function tokenResponse(body: unknown): TokenResponse | null {
	if (typeof body !== 'object' || body === null) return null;
	const { accessToken, tokenType, expiresAt, expiresIn } = body as Record<string, unknown>;
	if (typeof accessToken !== 'string' || !/^[\x21-\x7e]+$/.test(accessToken)) return null;
	if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') return null;
	if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) return null;
	if (typeof expiresIn !== 'number' || !Number.isInteger(expiresIn) || expiresIn < 1) return null;
	return { accessToken, expiresIn };
}

export function createServiceTokenSource(config: ServiceTokenSourceConfig): ServiceTokenSource {
	const { baseUrl, serviceId, credential, now, timeoutMs = TIMEOUT_MS } = config;
	let cached: CachedToken | null = null;
	let inflight: Promise<ServiceToken> | null = null;
	// Failed exchanges in a row, and when the next one may start: until then callers fail fast
	// instead of driving another credential verification. A success resets both.
	let failures = 0;
	let nextExchangeAt = 0;

	const failed = (delayMs: number | null = null): ServiceToken => {
		failures += 1;
		nextExchangeAt = now() + (delayMs ?? failureDelay(failures));
		return { ok: false };
	};

	// Configuration problems don't change between requests: say so once, not once per visitor.
	const logged = new Set<string>();
	const errorOnce = (message: string) => {
		if (logged.has(message)) return;
		logged.add(message);
		console.error(message);
	};

	async function exchange(): Promise<ServiceToken> {
		if (!serviceId || !credential) {
			errorOnce(
				'[commerce] COMMERCE_SERVICE_ID and COMMERCE_SERVICE_CREDENTIAL must be set for /book to reach fionas-commerce'
			);
			return { ok: false };
		}
		if (!UUID.test(serviceId)) {
			errorOnce('[commerce] COMMERCE_SERVICE_ID must be the UUID of SERVICE:fionas-web');
			return { ok: false };
		}

		// Lifetime counts from before the request: the token can't be older than that. Only
		// `expiresIn` is used, so a clock that disagrees with the backend's can't shorten it to nothing.
		const requestedAt = now();
		let response: Response;
		try {
			response = await config.fetch(`${baseUrl}/auth/service/token`, {
				method: 'POST',
				headers: { accept: 'application/json', 'content-type': 'application/json' },
				body: JSON.stringify({ serviceId, secret: credential }),
				cache: 'no-store',
				redirect: 'manual',
				signal: AbortSignal.timeout(timeoutMs)
			});
		} catch {
			console.error(
				'[commerce] service token exchange failed: fionas-commerce unreachable; check COMMERCE_API_URL'
			);
			return failed();
		}

		if (!response.ok) {
			const hint =
				response.status === 400 || response.status === 401
					? 'check COMMERCE_SERVICE_ID / COMMERCE_SERVICE_CREDENTIAL and that SERVICE:fionas-web is active'
					: 'fionas-commerce could not issue a service token';
			console.error(`[commerce] service token exchange failed → ${response.status}; ${hint}`);
			const wait = retryAfterMs(response);
			await response.body?.cancel().catch(() => {});
			return failed(wait);
		}

		const body: unknown = await response.json().catch(() => null);
		const issued = tokenResponse(body);
		if (!issued) {
			console.error(
				'[commerce] service token exchange returned a body outside the contract; not using it'
			);
			return failed();
		}
		failures = 0;
		nextExchangeAt = 0;
		const lifetime = issued.expiresIn * 1000;
		cached = {
			accessToken: issued.accessToken,
			expiresAt: requestedAt + lifetime,
			refreshAt: requestedAt + lifetime - refreshSkew(lifetime)
		};
		return { ok: true, accessToken: issued.accessToken };
	}

	return {
		async token() {
			const current = cached;
			if (current && now() < current.refreshAt)
				return { ok: true, accessToken: current.accessToken };

			// Cooling down after a failure: no exchange, but an unexpired token still serves.
			const fresh =
				!inflight && now() < nextExchangeAt
					? { ok: false as const }
					: await (inflight ??= exchange().finally(() => {
							inflight = null;
						}));
			if (fresh.ok) return fresh;
			// The refresh failed, but the token it was replacing hasn't expired yet: keep using it.
			if (current && current === cached && now() < current.expiresAt) {
				return { ok: true, accessToken: current.accessToken };
			}
			return fresh;
		},
		invalidate(accessToken) {
			if (cached?.accessToken === accessToken) cached = null;
		}
	};
}
