import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import {
	embeddedCheckout,
	embeddedSecret,
	openCheckout,
	publicId,
	quotedSummary,
	token
} from '$lib/payments/testing/fixtures.js';

const env: Record<string, string | undefined> = {
	COMMERCE_API_URL: 'http://commerce.internal:8080'
};
vi.mock('$env/dynamic/private', () => ({ env }));

const { createCheckout, paymentSummary, isPaymentPath, PAYMENT_CSP } =
	await import('./bff.server.js');

const origin = 'https://www.fionasicecream.com';
type Sent = { url: string; init: RequestInit };
let sent: Sent[] = [];
let reply: () => Response | Promise<Response>;

beforeEach(() => {
	sent = [];
	env.COMMERCE_API_URL = 'http://commerce.internal:8080';
	reply = () => Response.json(quotedSummary());
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: URL | string, init: RequestInit) => {
			sent.push({ url: String(url), init });
			return reply();
		})
	);
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function event(
	path: string,
	init: RequestInit & { headers?: Record<string, string> } = {},
	id = publicId
): RequestEvent {
	const url = new URL(path, origin);
	return {
		params: { publicId: id },
		url,
		request: new Request(url, init)
	} as unknown as RequestEvent;
}

const summaryEvent = (headers: Record<string, string> = {}, id = publicId) =>
	event(
		`/api/payments/${id}`,
		{
			headers: {
				'x-fionas-payment-token': token,
				cookie: 'session=public-site-cookie; other=1',
				authorization: 'Bearer service-token',
				'sec-fetch-site': 'same-origin',
				...headers
			}
		},
		id
	);

const command = '{"expectedDocumentVersion":3,"expectedBusinessRevision":4}';
const checkoutEvent = (headers: Record<string, string> = {}, body: string = command) =>
	event(`/api/payments/${publicId}/checkout-sessions`, {
		method: 'POST',
		body,
		headers: {
			origin,
			'content-type': 'application/json',
			'idempotency-key': 'ed5b1b8f-3f0a-4e63-9a1e-3c5d1f6f9b44',
			'x-fionas-payment-token': token,
			cookie: 'session=public-site-cookie',
			'x-forwarded-for': '203.0.113.9',
			...headers
		}
	});

const headersOf = (init: RequestInit) => Object.fromEntries(new Headers(init.headers).entries());

describe('summary BFF', () => {
	it('forwards exactly one bearer header to the configured commerce path, nothing else', async () => {
		const response = await paymentSummary(summaryEvent());
		expect(response.status).toBe(200);
		expect(sent).toHaveLength(1);
		expect(sent[0].url).toBe(`http://commerce.internal:8080/public/payments/${publicId}`);
		expect(sent[0].url).not.toContain(token);
		expect(headersOf(sent[0].init)).toEqual({
			accept: 'application/json',
			'x-fionas-payment-token': token
		});
		expect(sent[0].init.redirect).toBe('manual');
	});

	it('serves no-store, no-referrer and noindex', async () => {
		const response = await paymentSummary(summaryEvent());
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
		expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
	});

	it('re-serializes only customer-safe fields and refuses malformed summaries', async () => {
		reply = () => Response.json(quotedSummary({ customerEmail: 'private@example.com' }));
		const body = await (await paymentSummary(summaryEvent())).text();
		expect(body).not.toContain('private@example.com');
		reply = () => Response.json(quotedSummary({ requiredAmount: 240 }));
		const malformed = await paymentSummary(summaryEvent());
		expect(malformed.status).toBe(502);
		expect(await malformed.json()).toEqual({ code: 'invalid_response' });
	});

	it('refuses a missing, malformed or repeated bearer without calling commerce', async () => {
		for (const value of ['', 'short', `${token}, ${token}`]) {
			const response = await paymentSummary(summaryEvent({ 'x-fionas-payment-token': value }));
			expect(response.status).toBe(400);
		}
		expect(sent).toHaveLength(0);
	});

	it('refuses cross-site fetches and invalid publicIds', async () => {
		expect((await paymentSummary(summaryEvent({ 'sec-fetch-site': 'cross-site' }))).status).toBe(
			403
		);
		expect((await paymentSummary(summaryEvent({}, '../../staff/requests'))).status).toBe(404);
		expect(sent).toHaveLength(0);
	});

	it('passes through not-found and never forwards backend messages', async () => {
		reply = () => Response.json({ code: 'not_found', message: 'PRIVATE detail' }, { status: 404 });
		const response = await paymentSummary(summaryEvent());
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ code: 'not_found' });
	});

	it('distinguishes disabled Stripe, misconfiguration and an unreachable backend', async () => {
		reply = () => Response.json({ code: 'stripe_disabled', message: 'x' }, { status: 503 });
		expect(await (await paymentSummary(summaryEvent())).json()).toEqual({
			code: 'stripe_disabled'
		});
		reply = () => new Response('<html>bad gateway</html>', { status: 503 });
		expect((await paymentSummary(summaryEvent())).status).toBe(502);
		reply = () => Promise.reject(new TypeError('connect ECONNREFUSED'));
		expect((await paymentSummary(summaryEvent())).status).toBe(504);
		env.COMMERCE_API_URL = undefined;
		const missing = await paymentSummary(summaryEvent());
		expect(missing.status).toBe(503);
		expect(await missing.json()).toEqual({ code: 'payments_unavailable' });
		env.COMMERCE_API_URL = 'http://user:pass@commerce.internal';
		expect((await paymentSummary(summaryEvent())).status).toBe(503);
	});

	it('never logs the bearer or the commerce URL', async () => {
		reply = () => Promise.reject(new TypeError('connect ECONNREFUSED'));
		await paymentSummary(summaryEvent());
		const logged = JSON.stringify([
			vi.mocked(console.error).mock.calls,
			vi.mocked(console.warn).mock.calls
		]);
		expect(logged).not.toContain(token);
		expect(logged).not.toContain('commerce.internal');
		expect(logged).not.toContain(publicId);
	});
});

describe('checkout BFF', () => {
	it('forwards the bearer, one Idempotency-Key and the canonical command only', async () => {
		reply = () => Response.json(openCheckout);
		const response = await createCheckout(
			checkoutEvent({}, '{"expectedBusinessRevision":4,"expectedDocumentVersion":3}')
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(openCheckout);
		expect(sent[0].url).toBe(
			`http://commerce.internal:8080/public/payments/${publicId}/checkout-sessions`
		);
		expect(sent[0].init.method).toBe('POST');
		expect(sent[0].init.body).toBe(command);
		expect(headersOf(sent[0].init)).toEqual({
			accept: 'application/json',
			'content-type': 'application/json',
			'idempotency-key': 'ed5b1b8f-3f0a-4e63-9a1e-3c5d1f6f9b44',
			'x-fionas-payment-token': token
		});
	});

	it.each(['EMBEDDED', 'ELEMENTS'])(
		'whitelists the %s checkout answer, no-store, never logged',
		async (uiMode) => {
			const opened = { ...embeddedCheckout, uiMode };
			reply = () => Response.json({ ...opened, debug: 'internal', customerEmail: 'x@y.z' });
			const response = await createCheckout(checkoutEvent());
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual(opened);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(response.headers.get('referrer-policy')).toBe('no-referrer');
			const logged = JSON.stringify([
				vi.mocked(console.error).mock.calls,
				vi.mocked(console.warn).mock.calls
			]);
			expect(logged).not.toContain(embeddedSecret);
			reply = () => Response.json({ ...opened, state: 'PROCESSING', url: openCheckout.url });
			expect(await (await createCheckout(checkoutEvent())).json()).toEqual({
				attemptId: opened.attemptId,
				uiMode,
				state: 'PROCESSING',
				outcome: opened.outcome
			});
		}
	);

	it('never lets a launch credential through a payment summary', async () => {
		reply = () =>
			Response.json({ ...quotedSummary(), clientSecret: embeddedSecret, url: openCheckout.url });
		const response = await paymentSummary(summaryEvent());
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).not.toContain(embeddedSecret);
		expect(text).not.toContain('checkout.stripe.com');
	});

	it('answers an unknown or contradictory checkout mode as an invalid response', async () => {
		for (const body of [
			{ ...embeddedCheckout, uiMode: 'POPUP' },
			{ ...embeddedCheckout, url: openCheckout.url },
			{ ...embeddedCheckout, uiMode: 'ELEMENTS', url: openCheckout.url },
			{ ...embeddedCheckout, clientSecret: undefined }
		]) {
			reply = () => Response.json(body);
			const response = await createCheckout(checkoutEvent());
			expect(response.status).toBe(502);
			const text = await response.text();
			expect(JSON.parse(text)).toEqual({ code: 'invalid_response' });
			expect(text).not.toContain(embeddedSecret);
		}
	});

	it('relays a client secret whatever its undocumented format (development regression)', async () => {
		// The first deployed attempt answered 502: a strict cs_…[A-Za-z0-9_] pattern refused the
		// secret commerce received from Stripe. Any well-formed token must pass through.
		const clientSecret = 'cs_test_a1b2-c3_secret_fid#dWxOYHwnPyd1-blpx%2B%3D';
		reply = () => Response.json({ ...embeddedCheckout, clientSecret, url: null });
		const response = await createCheckout(checkoutEvent());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ...embeddedCheckout, clientSecret });
		expect(vi.mocked(console.error)).not.toHaveBeenCalled();
	});

	it('logs which check refused a commerce answer, never its values', async () => {
		const secret = 'cs_test_has a space_secret_x';
		reply = () => Response.json({ ...embeddedCheckout, clientSecret: secret });
		expect((await createCheckout(checkoutEvent())).status).toBe(502);
		expect(vi.mocked(console.error)).toHaveBeenCalledWith(
			'[payments] Commerce payments answered with an unreadable body',
			{ operation: 'checkout', problem: 'client_secret' }
		);
		reply = () => Response.json({ ...openCheckout, url: 'x'.repeat(5000) });
		await createCheckout(checkoutEvent());
		reply = () => Response.json({ ...quotedSummary(), lifecycle: 'quoted' });
		await paymentSummary(summaryEvent());
		reply = () => Response.json(openCheckout, { status: 201 });
		expect((await createCheckout(checkoutEvent())).status).toBe(502);
		expect(vi.mocked(console.error)).toHaveBeenCalledWith(
			'[payments] Commerce payments answered with an unexpected status',
			{ operation: 'checkout', status: 201 }
		);
		const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
		expect(logged).toContain('"problem":"url"');
		expect(logged).toContain('"operation":"summary","problem":"summary"');
		for (const value of [secret, 'xxxxxxxx', openCheckout.url, token, publicId, 'quoted'])
			expect(logged).not.toContain(value);
	});

	it('refuses cross-origin and cross-site POSTs', async () => {
		const refused: Record<string, string>[] = [
			{ origin: 'https://evil.example' },
			{ origin: 'null' },
			{ 'sec-fetch-site': 'cross-site' }
		];
		for (const headers of refused)
			expect((await createCheckout(checkoutEvent(headers))).status).toBe(403);
		const withoutOrigin = checkoutEvent();
		withoutOrigin.request.headers.delete('origin');
		expect((await createCheckout(withoutOrigin)).status).toBe(403);
		expect(sent).toHaveLength(0);
	});

	it.each([
		['form content', { 'content-type': 'application/x-www-form-urlencoded' }, command],
		['bad key', { 'idempotency-key': 'has space' }, command],
		['browser total', {}, '{"expectedDocumentVersion":3,"expectedBusinessRevision":4,"total":"1"}'],
		[
			'browser currency',
			{},
			'{"expectedDocumentVersion":3,"expectedBusinessRevision":4,"currency":"EUR"}'
		],
		[
			'fractional cents',
			{},
			'{"expectedDocumentVersion":6,"expectedBusinessRevision":8,"amountMinor":10.5}'
		],
		['not json', {}, 'expectedDocumentVersion=3'],
		[
			'oversized',
			{},
			`{"expectedDocumentVersion":3,"expectedBusinessRevision":4,"pad":"${'x'.repeat(2000)}"}`
		]
	])('refuses %s before calling commerce', async (_, headers, body) => {
		const response = await createCheckout(checkoutEvent(headers, body));
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.status).toBeLessThan(500);
		expect(sent).toHaveLength(0);
	});

	it('relays stable recovery codes and known conflict messages only', async () => {
		reply = () =>
			Response.json({ code: 'checkout_in_progress', message: 'free text' }, { status: 409 });
		expect(await (await createCheckout(checkoutEvent())).json()).toEqual({
			code: 'checkout_in_progress'
		});
		reply = () =>
			Response.json({ code: 'conflict', message: 'PAYMENT_TERMS_CHANGED' }, { status: 409 });
		expect(await (await createCheckout(checkoutEvent())).json()).toEqual({
			code: 'conflict',
			message: 'PAYMENT_TERMS_CHANGED'
		});
	});

	it('turns ambiguous backend outcomes into an unknown result, never a refusal', async () => {
		reply = () => Response.json({ code: 'internal_failure', message: 'x' }, { status: 500 });
		expect((await createCheckout(checkoutEvent())).status).toBe(502);
		reply = () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
		expect((await createCheckout(checkoutEvent())).status).toBe(504);
		reply = () =>
			new Response(null, { status: 302, headers: { location: 'https://evil.example' } });
		expect((await createCheckout(checkoutEvent())).status).toBe(502);
	});
});

it('covers the payment page, its data and the BFF only', () => {
	expect(isPaymentPath(`/pay/${publicId}`)).toBe(true);
	expect(isPaymentPath(`/pay/${publicId}/__data.json`)).toBe(true);
	expect(isPaymentPath(`/api/payments/${publicId}`)).toBe(true);
	expect(isPaymentPath('/payments')).toBe(false);
	expect(isPaymentPath('/book')).toBe(false);
});

it('keeps frame-ancestors none and frames only official Stripe origins', () => {
	const directives = Object.fromEntries(
		PAYMENT_CSP.split(';').map((part) => {
			const [name, ...values] = part.trim().split(/\s+/);
			return [name, values];
		})
	);
	expect(directives['frame-ancestors']).toEqual(["'none'"]);
	expect(directives['frame-src']).toEqual([
		'https://js.stripe.com',
		'https://*.js.stripe.com',
		'https://checkout.stripe.com',
		'https://hooks.stripe.com'
	]);
	expect(PAYMENT_CSP).not.toMatch(/unsafe|\s\*(\s|;|$)|http:|data:/);
});
