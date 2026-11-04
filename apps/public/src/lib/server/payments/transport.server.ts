import { env } from '$env/dynamic/private';

/**
 * The public site's only route to fionas-commerce, scoped to the customer payment endpoints.
 * The single reader of `COMMERCE_API_URL`. It sends the customer bearer and nothing else: no
 * cookies, no staff session, no SERVICE credential, no browser headers. It never logs the URL,
 * the bearer, the idempotency key, bodies or the publicId; logs carry only an operation name,
 * a status and a failure kind.
 */

const RESPONSE_LIMIT_BYTES = 262_144;

export type CommerceOperation = 'summary' | 'checkout';

export type CommerceResult =
	| { ok: true; status: number; body: unknown }
	| { ok: false; kind: 'misconfigured' | 'timeout' | 'network' };

/** The configured commerce origin, or null when unset or not a bare http(s) origin. */
export function commerceOrigin(): URL | null {
	const configured = env.COMMERCE_API_URL?.trim();
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
		)
			return null;
		return url;
	} catch {
		return null;
	}
}

async function readJson(response: Response): Promise<unknown> {
	const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
	if (mediaType !== 'application/json' || !response.body) {
		await response.body?.cancel().catch(() => undefined);
		return null;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > RESPONSE_LIMIT_BYTES) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		return null;
	}
}

const timedOut = (error: unknown) =>
	error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

export async function requestCommercePayments(
	operation: CommerceOperation,
	path: `/public/payments/${string}`,
	options: {
		token: string;
		idempotencyKey?: string;
		/** Canonical JSON command bytes, already validated. */
		body?: string;
		timeoutMs: number;
	}
): Promise<CommerceResult> {
	const origin = commerceOrigin();
	if (!origin) {
		console.error('[payments] Commerce payments are not configured', { operation });
		return { ok: false, kind: 'misconfigured' };
	}
	const headers: Record<string, string> = {
		accept: 'application/json',
		'x-fionas-payment-token': options.token
	};
	if (options.body !== undefined) headers['content-type'] = 'application/json';
	if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;
	try {
		const response = await fetch(new URL(path, origin), {
			method: options.body === undefined ? 'GET' : 'POST',
			headers,
			body: options.body,
			cache: 'no-store',
			redirect: 'manual',
			signal: AbortSignal.timeout(options.timeoutMs)
		});
		const body = await readJson(response);
		if (response.status >= 500)
			console.warn('[payments] Commerce payments answered with a server error', {
				operation,
				status: response.status
			});
		return { ok: true, status: response.status, body };
	} catch (error) {
		const kind = timedOut(error) ? 'timeout' : 'network';
		console.error('[payments] Commerce payments request failed', { operation, kind });
		return { ok: false, kind };
	}
}
