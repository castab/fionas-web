import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateInquiryRequest } from '@fionas/shared';
import {
	TEST_BASE_URL,
	TEST_UI_KEY,
	estimateFixture,
	fakeCommerce,
	type FakeCommerce
} from './testing/fake-commerce.js';

const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));

const { createInquiry, getInquiryForm, previewEstimate } = await import('./commerce.js');

/** Replaces the backend with one fixed answer (or failure) for every call. */
function answerEvery(respond: () => Response | Promise<Response>) {
	const calls: { url: string; init?: RequestInit }[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			return respond();
		})
	);
	return calls;
}

const KEY = '3b0f4c9e-8a51-4c2e-9d57-0f1e2a3b4c5d';

const inquiry: CreateInquiryRequest & Record<string, unknown> = {
	name: 'Jane Doe',
	email: 'jane@example.com',
	zipCode: '02134',
	eventDate: '2026-12-05',
	eventType: 'BIRTHDAY',
	pricingInputs: {
		catalogRevision: 15,
		guestCount: 75,
		guestCountIsMinimum: false,
		durationMinutes: 120,
		selections: [{ category: 'cone-option', offerings: ['waffle-cone'] }]
	}
};

let backend: FakeCommerce;
let logs: string[];

beforeEach(() => {
	env.COMMERCE_API_URL = `${TEST_BASE_URL}/`;
	env.FIONAS_UI_API_KEY = TEST_UI_KEY;
	backend = fakeCommerce();
	vi.stubGlobal('fetch', vi.fn(backend.fetch));
	logs = [];
	const capture = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
	vi.spyOn(console, 'warn').mockImplementation(capture);
	vi.spyOn(console, 'error').mockImplementation(capture);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('createInquiry', () => {
	it('sends the bearer key, the idempotency key and the JSON intent to the configured API', async () => {
		const result = await createInquiry(inquiry, KEY);

		expect(result).toEqual({
			ok: true,
			data: { id: expect.any(String), createdAt: expect.any(String) }
		});
		const [post] = backend.posts();
		expect(post).toMatchObject({
			path: '/inquiries',
			headers: {
				authorization: `Bearer ${TEST_UI_KEY}`,
				'idempotency-key': KEY,
				'content-type': 'application/json',
				accept: 'application/json'
			},
			body: inquiry
		});
	});

	it('refuses to send without a usable logical submission key', async () => {
		await expect(createInquiry(inquiry, '')).rejects.toThrow(/submission key/);
		await expect(createInquiry(inquiry, 'has spaces')).rejects.toThrow(/submission key/);
		expect(backend.calls).toHaveLength(0);
	});

	it('retries a lost response once with the SAME key and gets the original receipt back', async () => {
		backend.script('commit-then-drop');
		const result = await createInquiry(inquiry, KEY);

		expect(result.ok).toBe(true);
		const keys = backend.posts().map((c) => c.headers['idempotency-key']);
		expect(keys).toEqual([KEY, KEY]);
		expect(backend.committed.size).toBe(1);
		expect(result.ok && result.data).toEqual(backend.committed.get(KEY)?.receipt);
	});

	it('treats an unreadable 201 as ambiguous and recovers the receipt by replay', async () => {
		backend.script('commit-then-garble');
		const result = await createInquiry(inquiry, KEY);
		expect(result.ok && result.data).toEqual(backend.committed.get(KEY)?.receipt);
		expect(backend.posts()).toHaveLength(2);
	});

	it('retries gateway errors and the documented customer-creation conflict once', async () => {
		backend.script({ status: 503 }, { status: 409, body: { code: 'conflict', message: 'm' } });
		expect((await createInquiry(inquiry, KEY)).ok).toBe(false);
		expect(backend.posts().map((c) => c.headers['idempotency-key'])).toEqual([KEY, KEY]);
	});

	it('gives up after two attempts, reporting the backend as unreachable', async () => {
		backend.script('network', 'network');
		const result = await createInquiry(inquiry, KEY);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: 'network', status: 503, code: 'unavailable' }
		});
		expect(backend.posts()).toHaveLength(2);
	});

	it('classifies a timeout as such and repeats the identical body under the same key', async () => {
		const calls = answerEvery(() => {
			throw new DOMException('The operation timed out.', 'TimeoutError');
		});
		const result = await createInquiry(inquiry, KEY);
		expect(result).toMatchObject({ ok: false, error: { kind: 'timeout', code: 'timeout' } });
		expect(calls).toHaveLength(2);
		expect(new Set(calls.map((c) => c.init?.body)).size).toBe(1);
		expect(calls.map((c) => new Headers(c.init?.headers).get('idempotency-key'))).toEqual([
			KEY,
			KEY
		]);
	});

	it('refuses to send an inquiry without pricingInputs', async () => {
		const contactOnly: Record<string, unknown> = { ...inquiry };
		delete contactOnly.pricingInputs;
		await expect(
			createInquiry(contactOnly as unknown as CreateInquiryRequest, KEY)
		).rejects.toThrow(/pricingInputs/);
		expect(backend.calls).toHaveLength(0);
	});

	it('fails closed on a 201 that is not a receipt', async () => {
		answerEvery(() => Response.json({ ok: true }, { status: 201 }));
		const result = await createInquiry(inquiry, KEY);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: 'unexpected', code: 'bad_response' }
		});
	});

	it('never follows a redirect and treats it as unexpected', async () => {
		const calls = answerEvery(
			() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } })
		);
		const result = await getInquiryForm();
		expect(result).toMatchObject({ ok: false, error: { kind: 'unexpected', status: 302 } });
		expect(calls[0]?.init?.redirect).toBe('manual');
	});

	it.each([
		[
			422,
			{ code: 'validation_failed', message: 'm', violations: [{ code: 'INVALID_GUEST_COUNT' }] }
		],
		[409, { code: 'CATALOG_REVISION_STALE', message: 'm' }],
		[409, { code: 'IDEMPOTENCY_KEY_REUSED', message: 'm' }],
		[400, { code: 'malformed_request', message: 'm' }],
		[500, { code: 'internal_failure', message: 'm' }]
	])('never retries a %i %o', async (status, body) => {
		backend.script({ status, body });
		const result = await createInquiry(inquiry, KEY);
		expect(result).toMatchObject({ ok: false, error: { status, code: body.code } });
		expect(backend.posts()).toHaveLength(1);
	});

	it('maps violation codes and never exposes or logs the bearer key', async () => {
		env.FIONAS_UI_API_KEY = 'wrong-key';
		const result = await createInquiry(inquiry, KEY);
		expect(result).toMatchObject({ ok: false, error: { status: 401, code: 'unauthenticated' } });
		expect(JSON.stringify(result)).not.toContain('wrong-key');
		expect(logs.join('\n')).not.toContain('wrong-key');
		expect(logs.join('\n')).toMatch(/FIONAS_UI_API_KEY/);
		expect(result.ok || result.error.kind).toBe('unauthorized');
	});

	it.each([
		[422, 'validation'],
		[400, 'validation'],
		[404, 'not_found'],
		[409, 'conflict'],
		[500, 'server']
	])('classifies a %i as %s and keeps the stable code', async (status, kind) => {
		backend.script({ status, body: { code: 'SOME_STABLE_CODE', message: 'diagnostic' } });
		const result = await createInquiry(inquiry, KEY);
		expect(result).toMatchObject({ ok: false, error: { kind, code: 'SOME_STABLE_CODE' } });
	});
});

describe('getInquiryForm', () => {
	it('reads the form with the bearer key', async () => {
		const result = await getInquiryForm();
		expect(result.ok && result.data.catalogRevision).toBe(15);
		expect(backend.calls[0]).toMatchObject({
			method: 'GET',
			path: '/inquiry-form',
			headers: { authorization: `Bearer ${TEST_UI_KEY}` }
		});
		expect(backend.calls[0]?.headers['cache-control']).toBeUndefined();
	});

	it('bypasses every cache when asked for a fresh copy', async () => {
		await getInquiryForm({ fresh: true });
		expect(backend.calls[0]).toMatchObject({
			cache: 'no-store',
			headers: { 'cache-control': 'no-cache' }
		});
	});

	it('fails closed on a 200 outside the documented shape', async () => {
		answerEvery(() => Response.json({ definitionVersion: 7, sections: 'nope' }));
		const result = await getInquiryForm();
		expect(result).toMatchObject({
			ok: false,
			error: { kind: 'unexpected', code: 'bad_response' }
		});
		expect(logs.join(' ')).toMatch(/outside the contract/);
	});

	it('sends no Authorization header when no key is configured', async () => {
		env.FIONAS_UI_API_KEY = '  ';
		const result = await getInquiryForm();
		expect(result).toMatchObject({ ok: false, error: { status: 401 } });
		expect(backend.calls[0]?.headers.authorization).toBeUndefined();
	});
});

describe('previewEstimate', () => {
	const pricing = inquiry.pricingInputs;

	it('posts the pricing inputs with the bearer key and returns the backend figures', async () => {
		const result = await previewEstimate(pricing);
		expect(result).toEqual({ ok: true, data: estimateFixture() });
		expect(backend.calls[0]).toMatchObject({
			method: 'POST',
			path: '/estimate-preview',
			headers: { authorization: `Bearer ${TEST_UI_KEY}`, 'content-type': 'application/json' },
			body: pricing
		});
		// Previews write nothing and need no Idempotency-Key.
		expect(backend.calls[0]?.headers['idempotency-key']).toBeUndefined();
	});

	it('fails closed on figures outside the documented shape', async () => {
		answerEvery(() => Response.json({ total: 12.5 }));
		expect(await previewEstimate(pricing)).toMatchObject({
			ok: false,
			error: { kind: 'unexpected' }
		});
	});

	it('keeps validation violation codes', async () => {
		backend.script({
			status: 422,
			body: {
				code: 'validation_failed',
				message: 'diagnostic',
				violations: [{ code: 'TOO_MANY_SELECTIONS' }]
			}
		});
		expect(await previewEstimate(pricing)).toMatchObject({
			ok: false,
			error: { kind: 'validation', violations: ['TOO_MANY_SELECTIONS'] }
		});
	});
});
