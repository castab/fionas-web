import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	TEST_BASE_URL,
	TEST_UI_KEY,
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
	env.FIONAS_UI_API_KEY = TEST_UI_KEY;
	env.BOOKING_ENABLED = 'true';
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
	it('forwards only the pricing facts, with the server-side key, and returns the figures', async () => {
		const { status, text } = await estimate({ ...pricing, total: '1.00', lines: [] });

		expect(status).toBe(200);
		expect(JSON.parse(text)).toEqual(estimateFixture());
		expect(backend.calls).toEqual([
			expect.objectContaining({
				method: 'POST',
				path: '/estimate-preview',
				headers: expect.objectContaining({ authorization: `Bearer ${TEST_UI_KEY}` }),
				// Browser-supplied amounts never travel upstream.
				body: pricing
			})
		]);
		expect(text).not.toContain(TEST_UI_KEY);
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

	it('reports a refused credential as an outage, not as a refusal of the choices', async () => {
		env.FIONAS_UI_API_KEY = 'rotated-elsewhere';
		const { status, text } = await estimate(pricing);
		expect(status).toBe(503);
		expect(text).not.toContain('rotated-elsewhere');
	});
});
