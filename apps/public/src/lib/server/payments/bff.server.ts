import { json, type RequestEvent } from '@sveltejs/kit';
import {
	IDEMPOTENCY_KEY,
	PAYMENT_TOKEN,
	UUID,
	inspectCheckoutResponse,
	readCheckoutCommand,
	type CheckoutCommand,
	readPaymentError,
	readPaymentSummary,
	serializeCommand
} from '$lib/payments/contract.js';
import { requestCommercePayments, type CommerceResult } from './transport.server.js';

/**
 * The customer payment backend-for-frontend: exactly two same-origin endpoints, never a generic
 * proxy. The browser supplies the publicId (path), the bearer (one header), and for checkout one
 * Idempotency-Key and the reviewed command. Everything is validated before any commerce call;
 * no other browser header, cookie or URL is forwarded, and responses are re-serialized from the
 * documented customer-safe fields only.
 *
 * An embedded Checkout's client secret is one of those fields only in the checkout POST answer
 * (to the bearer holder who asked for it): summaries, page loads and errors never carry it, and
 * like the hosted URL it is never logged.
 */

/** Sent on every payment page and BFF response (see also hooks.server.ts). */
export const PAYMENT_HEADERS = {
	'cache-control': 'no-store',
	'referrer-policy': 'no-referrer',
	'x-robots-tag': 'noindex, nofollow'
} as const;

/**
 * The payment routes' Content-Security-Policy (set in hooks.server.ts). Nothing may frame the
 * payment page (no clickjacking of the Pay button), and the page may frame only Stripe: Embedded
 * Checkout and Stripe.js's own frames (js.stripe.com), hosted Checkout, and 3D Secure /
 * redirect-based authentication (hooks.stripe.com), per Stripe's documented CSP. The site sets
 * no script-src or connect-src today, so Stripe.js (requested from https://js.stripe.com only)
 * and its API calls aren't restricted further; see docs/customer-payments.md before adding one.
 */
export const PAYMENT_CSP = [
	"frame-ancestors 'none'",
	'frame-src https://js.stripe.com https://*.js.stripe.com https://checkout.stripe.com https://hooks.stripe.com'
].join('; ');

/** The customer payment page (with its __data.json and error pages) and this BFF. */
export const isPaymentPath = (pathname: string) =>
	pathname === '/pay' || pathname.startsWith('/pay/') || pathname.startsWith('/api/payments/');

const SUMMARY_TIMEOUT_MS = 10_000;
// Commerce may contact Stripe (and recover an earlier attempt) within one checkout command.
const CHECKOUT_TIMEOUT_MS = 35_000;
const MAX_COMMAND_BYTES = 1024;

const reply = (status: number, body: unknown) => json(body, { status, headers: PAYMENT_HEADERS });

/** Exactly one well-formed bearer header (a repeated header arrives comma-joined and fails). */
function bearer(request: Request): string | null {
	const value = request.headers.get('x-fionas-payment-token');
	return value !== null && PAYMENT_TOKEN.test(value) ? value : null;
}

/** Fetch metadata, when the browser sends it, must say the request came from this origin. */
const crossSite = (request: Request) => {
	const site = request.headers.get('sec-fetch-site');
	return site !== null && site !== 'same-origin';
};

/** A whitelisted success body, or the fixed reason it was refused (safe to log; no values). */
type Read = { value: unknown } | { problem: string };

const readSummary = (body: unknown): Read => {
	const value = readPaymentSummary(body);
	return value ? { value } : { problem: 'summary' };
};
const readCheckout = (body: unknown): Read => {
	const read = inspectCheckoutResponse(body);
	return 'response' in read ? { value: read.response } : { problem: read.problem };
};

function relay(
	operation: 'summary' | 'checkout',
	result: CommerceResult,
	readSuccess: (body: unknown) => Read
): Response {
	if (!result.ok)
		return result.kind === 'misconfigured'
			? reply(503, { code: 'payments_unavailable' })
			: // Timeout or lost connection: the outcome is unknown.
				reply(504, { code: 'unavailable' });
	const { status, body } = result;
	if (status === 200) {
		const read = readSuccess(body);
		if ('value' in read) return reply(200, read.value);
		// Commerce answered but the body failed a check: the outcome is unknown to the customer,
		// so operators need to know which check. Only the fixed check name is logged, never values.
		console.error('[payments] Commerce payments answered with an unreadable body', {
			operation,
			problem: read.problem
		});
		return reply(502, { code: 'invalid_response' });
	}
	const error = readPaymentError(body);
	if (status === 503 && error?.code === 'stripe_disabled')
		return reply(503, { code: 'stripe_disabled' });
	if ([400, 404, 409, 422].includes(status))
		return reply(status, error ?? { code: status === 409 ? 'conflict' : 'malformed_request' });
	// 5xx (already logged by the transport), redirects and unexpected statuses: never
	// interpreted, treated as an unknown outcome.
	if (status < 500)
		console.error('[payments] Commerce payments answered with an unexpected status', {
			operation,
			status
		});
	return reply(502, { code: 'internal_failure' });
}

const commercePath = (publicId: string) =>
	`/public/payments/${encodeURIComponent(publicId.toLowerCase())}` as const;

export async function paymentSummary({ params, request }: RequestEvent): Promise<Response> {
	const publicId = params.publicId ?? '';
	if (!UUID.test(publicId)) return reply(404, { code: 'not_found' });
	if (crossSite(request)) return reply(403, { code: 'forbidden' });
	const token = bearer(request);
	if (!token) return reply(400, { code: 'malformed_request' });
	return relay(
		'summary',
		await requestCommercePayments('summary', commercePath(publicId), {
			token,
			timeoutMs: SUMMARY_TIMEOUT_MS
		}),
		readSummary
	);
}

async function readLimited(request: Request): Promise<string | null> {
	const declared = request.headers.get('content-length');
	if (declared !== null && !(Number(declared) <= MAX_COMMAND_BYTES)) return null;
	if (!request.body) return null;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_COMMAND_BYTES) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
	} catch {
		return null;
	}
}

export async function createCheckout({ params, request, url }: RequestEvent): Promise<Response> {
	const publicId = params.publicId ?? '';
	if (!UUID.test(publicId)) return reply(404, { code: 'not_found' });
	// The bearer is the authorization; this keeps other sites from invoking it in a visitor's tab.
	if (request.headers.get('origin') !== url.origin || crossSite(request))
		return reply(403, { code: 'forbidden' });
	const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
	if (mediaType !== 'application/json') return reply(415, { code: 'malformed_request' });
	const token = bearer(request);
	const key = request.headers.get('idempotency-key');
	if (!token || key === null || !IDEMPOTENCY_KEY.test(key))
		return reply(400, { code: 'malformed_request' });
	const raw = await readLimited(request);
	let command: CheckoutCommand | null;
	try {
		command = raw === null ? null : readCheckoutCommand(JSON.parse(raw));
	} catch {
		command = null;
	}
	if (!command) return reply(400, { code: 'malformed_request' });
	return relay(
		'checkout',
		await requestCommercePayments('checkout', `${commercePath(publicId)}/checkout-sessions`, {
			token,
			idempotencyKey: key,
			body: serializeCommand(command),
			timeoutMs: CHECKOUT_TIMEOUT_MS
		}),
		readCheckout
	);
}
