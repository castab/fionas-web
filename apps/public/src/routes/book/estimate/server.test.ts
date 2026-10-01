import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	TEST_BASE_URL,
	TEST_SERVICE_CREDENTIAL,
	TEST_SERVICE_ID,
	estimateFixture,
	fakeCommerce,
	type FakeCommerce
} from '$lib/server/testing/fake-commerce.js';

/*
 * Integration: the browser's estimate request → this endpoint → the server-only adapter → (fake)
 * fionas-commerce POST /estimate-preview. Advisory only: nothing is written anywhere.
 */

const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));

const { POST } = await import('./+server.js');
const { resetCommerceClient } = await import('$lib/server/commerce.js');

const pricing = {
	catalogRevision: 15,
	guestCount: 75,
	guestCountIsMinimum: false,
	durationMinutes: 120,
	selections: [{ category: 'cone-option', offerings: ['waffle-cone'] }]
};

let backend: FakeCommerce;

beforeEach(() => {
	env.COMMERCE_API_URL = TEST_BASE_URL;
	env.COMMERCE_SERVICE_ID = TEST_SERVICE_ID;
	env.COMMERCE_SERVICE_CREDENTIAL = TEST_SERVICE_CREDENTIAL;
	env.BOOKING_ENABLED = 'true';
	resetCommerceClient();
	backend = fakeCommerce();
	vi.stubGlobal('fetch', vi.fn(backend.fetch));
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function estimate(body: unknown) {
	const request = new Request('https://fionasicecream.com/book/estimate', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body)
	});
	const response = await POST({ request } as never);
	return { status: response.status, text: await response.text() };
}

describe('/book/estimate', () => {
	it('forwards only the pricing facts, as the site SERVICE, and returns the figures', async () => {
		const { status, text } = await estimate({ ...pricing, total: '1.00', lines: [] });

		expect(status).toBe(200);
		expect(JSON.parse(text)).toEqual(estimateFixture());
		expect(backend.calls).toEqual([
			expect.objectContaining({
				method: 'POST',
				path: '/estimate-preview',
				headers: expect.objectContaining({ authorization: `Bearer ${backend.tokens()[0]}` }),
				// Browser-supplied amounts never travel upstream.
				body: pricing
			})
		]);
		expect(text).not.toContain('test-access-token');
		expect(text).not.toContain(TEST_SERVICE_CREDENTIAL);
	});

	it.each([
		['not JSON', '{'],
		['no guest count', { ...pricing, guestCount: undefined }],
		['a fractional guest count', { ...pricing, guestCount: 7.5 }],
		['malformed selections', { ...pricing, selections: [{ category: 1 }] }]
	])('refuses %s without calling the backend', async (_, body) => {
		const { status } = await estimate(body);
		expect(status).toBe(400);
		expect(backend.calls).toHaveLength(0);
	});

	it('passes stable violation codes through, never the diagnostic message', async () => {
		backend.script({
			status: 422,
			body: {
				code: 'validation_failed',
				message: 'secret diagnostic',
				violations: [{ code: 'OFFERING_UNAVAILABLE' }]
			}
		});
		const { status, text } = await estimate(pricing);
		expect(status).toBe(422);
		expect(JSON.parse(text)).toEqual({
			code: 'validation_failed',
			violations: ['OFFERING_UNAVAILABLE']
		});
	});

	it('reports a refused service credential as an outage, not as a refusal of the choices', async () => {
		env.COMMERCE_SERVICE_CREDENTIAL = 'revoked-elsewhere';
		const { status, text } = await estimate(pricing);
		expect(status).toBe(503);
		expect(JSON.parse(text)).toEqual({ code: 'unavailable' });
		expect(text).not.toContain('revoked-elsewhere');
		expect(backend.calls).toHaveLength(0);
	});

	it('reports a missing permission (403) as an outage, never as a rejected selection', async () => {
		backend.revoke('fionas.estimate-preview.create');
		const { status, text } = await estimate(pricing);
		// 5xx: the page keeps its advisory estimate; a 4xx would hide it as "rejected".
		expect(status).toBe(503);
		expect(JSON.parse(text)).toEqual({ code: 'unavailable' });
		expect(backend.calls).toHaveLength(1);
		expect(backend.exchanges).toHaveLength(1);
	});

	it('recovers from an expired token without the browser noticing', async () => {
		await estimate(pricing);
		backend.expireTokens();
		const { status } = await estimate(pricing);
		expect(status).toBe(200);
		expect(backend.tokens()).toHaveLength(2);
	});
});
