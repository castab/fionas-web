import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateInquiryRequest } from '@fionas/shared';
import {
	TEST_BASE_URL,
	TEST_SERVICE_CREDENTIAL,
	TEST_SERVICE_ID,
	fakeCommerce,
	type FakeCommerce
} from './testing/fake-commerce.js';

const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));

const { createCommerceClient, createInquiry, isOutcomeUnknown, resetCommerceClient } =
	await import('./commerce.js');

/** Replaces the backend's protected endpoints with one fixed answer (or failure) for every call. */
function answerEvery(respond: () => Response | Promise<Response>) {
	const calls: { url: string; init?: RequestInit }[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			// Token exchanges still go to the fake backend: only the protected answer is replaced.
			if (url.endsWith('/auth/service/token')) return backend.fetch(url, init);
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
	requestedService: { guestCount: 75 },
	lines: [
		{ description: 'Synthetic service', unitPrice: '101.00', taxAmount: '0.00', currency: 'USD' }
	]
};

let backend: FakeCommerce;
let logs: string[];

beforeEach(() => {
	env.COMMERCE_API_URL = `${TEST_BASE_URL}/`;
	env.COMMERCE_SERVICE_ID = TEST_SERVICE_ID;
	env.COMMERCE_SERVICE_CREDENTIAL = TEST_SERVICE_CREDENTIAL;
	resetCommerceClient();
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

/** Nothing secret ever appears in a result or a log line. */
function expectNoSecrets(result: unknown) {
	const seen = `${JSON.stringify(result)}\n${logs.join('\n')}`;
	expect(seen).not.toContain(TEST_SERVICE_CREDENTIAL);
	expect(seen).not.toContain('test-access-token');
	expect(seen).not.toContain('Bearer');
}

describe('createInquiry', () => {
	it('sends the service token, the idempotency key and the JSON intent to the configured API', async () => {
		const result = await createInquiry(inquiry, KEY);

		expect(result).toEqual({
			ok: true,
			data: { id: expect.any(String), createdAt: expect.any(String) }
		});
		expect(backend.exchanges).toEqual([{ serviceId: TEST_SERVICE_ID, accepted: true }]);
		const [post] = backend.posts();
		expect(post).toMatchObject({
			path: '/inquiries',
			headers: {
				authorization: `Bearer ${backend.tokens()[0]}`,
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

	it('retries the retryable conflict with the same key and body, then succeeds', async () => {
		backend.script({ status: 409, body: { code: 'conflict', message: 'm' } });
		const result = await createInquiry(inquiry, KEY);
		expect(result.ok).toBe(true);
		const posts = backend.posts();
		expect(posts.map((c) => c.headers['idempotency-key'])).toEqual([KEY, KEY]);
		expect(posts[0]?.body).toEqual(posts[1]?.body);
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

	it('refuses to send an inquiry without requestedService', async () => {
		const contactOnly: Record<string, unknown> = { ...inquiry };
		delete contactOnly.requestedService;
		await expect(
			createInquiry(contactOnly as unknown as CreateInquiryRequest, KEY)
		).rejects.toThrow(/requestedService/);
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
		const result = await createInquiry(inquiry, KEY);
		expect(result).toMatchObject({ ok: false, error: { kind: 'unexpected', status: 302 } });
		expect(calls[0]?.init?.redirect).toBe('manual');
	});

	it.each([
		[
			422,
			{ code: 'validation_failed', message: 'm', violations: [{ code: 'INVALID_GUEST_COUNT' }] }
		],
		[409, { code: 'IDEMPOTENCY_KEY_REUSED', message: 'm' }],
		[400, { code: 'malformed_request', message: 'm' }],
		[404, { code: 'not_found', message: 'm' }]
	])('never retries a definite refusal: %i %o', async (status, body) => {
		backend.script({ status, body });
		const result = await createInquiry(inquiry, KEY);
		expect(result).toMatchObject({ ok: false, error: { status, code: body.code } });
		expect(backend.posts()).toHaveLength(1);
	});

	describe('a 500 proves nothing was written', () => {
		const internal = { status: 500, body: { code: 'internal_failure', message: 'm' } };

		it('retries once with the identical body and key, and takes the receipt', async () => {
			backend.script(internal);
			const result = await createInquiry(inquiry, KEY);

			expect(result.ok).toBe(true);
			const posts = backend.posts();
			expect(posts).toHaveLength(2);
			expect(posts.map((c) => c.headers['idempotency-key'])).toEqual([KEY, KEY]);
			expect(JSON.stringify(posts[1]?.body)).toBe(JSON.stringify(posts[0]?.body));
		});

		it('leaves the outcome unknown when both deliveries answer 500', async () => {
			backend.script(internal, internal);
			const result = await createInquiry(inquiry, KEY);

			expect(result).toMatchObject({ ok: false, error: { kind: 'server', status: 500 } });
			expect(!result.ok && isOutcomeUnknown(result.error)).toBe(true);
			expect(backend.posts()).toHaveLength(2);
		});

		it('recovers the original receipt when the 500 hid a commit', async () => {
			backend.script('commit-then-500');
			const result = await createInquiry(inquiry, KEY);

			expect(result.ok && result.data).toEqual(backend.committed.get(KEY)?.receipt);
			expect(backend.committed.size).toBe(1);
			expect(backend.posts()).toHaveLength(2);
		});
	});

	it.each([
		['a timeout', { kind: 'timeout', status: 504, code: 'timeout' }, true],
		['a network failure', { kind: 'network', status: 503, code: 'unavailable' }, true],
		['a 500', { kind: 'server', status: 500, code: 'internal_failure' }, true],
		['a 502', { kind: 'server', status: 502, code: 'bad_gateway' }, true],
		['a 503', { kind: 'server', status: 503, code: 'internal_failure' }, true],
		['a misshapen success', { kind: 'unexpected', status: 502, code: 'bad_response' }, true],
		['a redirect', { kind: 'unexpected', status: 302, code: 'internal_failure' }, true],
		['the retryable conflict', { kind: 'conflict', status: 409, code: 'conflict' }, true],
		['400', { kind: 'validation', status: 400, code: 'malformed_request' }, false],
		['404', { kind: 'not_found', status: 404, code: 'not_found' }, false],
		['422', { kind: 'validation', status: 422, code: 'validation_failed' }, false],
		['a reused key', { kind: 'conflict', status: 409, code: 'IDEMPOTENCY_KEY_REUSED' }, false],
		['a service-auth failure', { kind: 'service_auth', status: 503, code: 'unavailable' }, false]
	] as const)('decides whether %s leaves the outcome unknown', (_, error, unknown) => {
		expect(isOutcomeUnknown({ ...error, message: 'm', violations: [] })).toBe(unknown);
	});

	it('reports a refused service credential as an outage, sends nothing and leaks nothing', async () => {
		env.COMMERCE_SERVICE_CREDENTIAL = 'wrong-credential-value';
		const result = await createInquiry(inquiry, KEY);

		expect(result).toMatchObject({
			ok: false,
			error: { kind: 'service_auth', status: 503, code: 'unavailable' }
		});
		expect(backend.exchanges).toEqual([{ serviceId: TEST_SERVICE_ID, accepted: false }]);
		expect(backend.posts()).toHaveLength(0);
		expect(logs.join('\n')).toMatch(
			/service token exchange failed → 401; check COMMERCE_SERVICE_ID/
		);
		expect(`${JSON.stringify(result)}\n${logs.join('\n')}`).not.toContain('wrong-credential-value');
		expectNoSecrets(result);
	});

	it.each([
		[422, 'validation'],
		[400, 'validation'],
		[404, 'not_found'],
		[409, 'conflict'],
		[500, 'server']
	])('classifies a %i as %s and keeps the stable code', async (status, kind) => {
		const answer = { status, body: { code: 'SOME_STABLE_CODE', message: 'diagnostic' } };
		backend.script(answer, answer);
		const result = await createInquiry(inquiry, KEY);
		expect(result).toMatchObject({ ok: false, error: { kind, code: 'SOME_STABLE_CODE' } });
	});
});

describe('service authentication', () => {
	let clock: number;

	/** A client of its own, on the fake backend, with a clock the test moves. */
	function client(fetch: typeof globalThis.fetch = backend.fetch) {
		clock = Date.UTC(2026, 9, 1, 12);
		return createCommerceClient({
			baseUrl: TEST_BASE_URL,
			serviceId: TEST_SERVICE_ID,
			credential: TEST_SERVICE_CREDENTIAL,
			fetch,
			now: () => clock,
			retryDelayMs: 0
		});
	}

	const bearers = () => backend.calls.map((c) => c.headers.authorization);

	it('acquires a token lazily, on the first protected call', async () => {
		const commerce = client();
		expect(backend.exchanges).toHaveLength(0);

		await commerce.createInquiry(inquiry, KEY);
		expect(backend.exchanges).toHaveLength(1);
		expect(bearers()).toEqual(['Bearer test-access-token-1']);
	});

	it('reuses the token across sequential calls', async () => {
		const commerce = client();
		await commerce.createInquiry(inquiry, KEY);
		await commerce.createInquiry(inquiry, KEY);
		await commerce.createInquiry(inquiry, KEY);
		expect(backend.exchanges).toHaveLength(1);
		expect(new Set(bearers())).toEqual(new Set(['Bearer test-access-token-1']));
	});

	it('performs one exchange for many concurrent calls', async () => {
		const commerce = client();
		const results = await Promise.all([
			commerce.createInquiry(inquiry, KEY),
			commerce.createInquiry(inquiry, KEY),
			commerce.createInquiry(inquiry, KEY),
			commerce.createInquiry(inquiry, KEY)
		]);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(backend.exchanges).toHaveLength(1);
	});

	it('replaces the token before it expires, using the injected clock', async () => {
		const commerce = client();
		await commerce.createInquiry(inquiry, KEY);
		clock += 14 * 60_000; // a 15-minute token is due for replacement a minute early
		await commerce.createInquiry(inquiry, KEY);
		expect(backend.exchanges).toHaveLength(2);
		expect(bearers()).toEqual(['Bearer test-access-token-1', 'Bearer test-access-token-2']);
	});

	it('recovers from a 401 with a new token and repeats the identical POST /inquiries once', async () => {
		const commerce = client();
		await commerce.createInquiry(inquiry, KEY);
		backend.expireTokens();

		const result = await commerce.createInquiry(inquiry, KEY);

		expect(result.ok).toBe(true);
		const posts = backend.posts().slice(-2);
		expect(posts).toHaveLength(2);
		expect(posts.map((c) => c.headers.authorization)).toEqual([
			'Bearer test-access-token-1',
			'Bearer test-access-token-2'
		]);
		// Same business request: same Idempotency-Key, same body; only the bearer token changed.
		expect(posts.map((c) => c.headers['idempotency-key'])).toEqual([KEY, KEY]);
		expect(posts[1]?.body).toEqual(posts[0]?.body);
		expect({ ...posts[1]?.headers, authorization: '' }).toEqual({
			...posts[0]?.headers,
			authorization: ''
		});
		expect(backend.committed.size).toBe(1);
	});

	it('never retries authentication more than once', async () => {
		// Every protected call is refused, however fresh the token.
		const commerce = client(async (input, init) => {
			const response = await backend.fetch(input, init);
			return String(input).endsWith('/auth/service/token')
				? response
				: Response.json({ code: 'unauthenticated', message: 'm' }, { status: 401 });
		});

		const result = await commerce.createInquiry(inquiry, KEY);

		expect(result).toMatchObject({ ok: false, error: { kind: 'service_auth', status: 503 } });
		expect(backend.posts()).toHaveLength(2);
		expect(backend.exchanges).toHaveLength(2);
		expect(logs.join('\n')).toMatch(/POST \/inquiries → 401 with a fresh service token/);
		expectNoSecrets(result);
	});

	it('does not let a slow 401 discard a newer token another request installed', async () => {
		let release!: () => void;
		let hold: Promise<void> | null = null;
		const commerce = client(async (input, init) => {
			const response = await backend.fetch(input, init);
			// Request A's first answer (a 401 for the expired token) arrives late.
			if (hold && String(input).endsWith('/inquiries')) {
				const late = hold;
				hold = null;
				await late;
			}
			return response;
		});
		await commerce.createInquiry(inquiry, KEY);
		backend.expireTokens();
		hold = new Promise((resolve) => (release = resolve));

		const a = commerce.createInquiry(inquiry, KEY);
		// Request B also gets a 401, refreshes, and installs token 2.
		expect((await commerce.createInquiry(inquiry, KEY)).ok).toBe(true);
		expect(backend.tokens()).toEqual(['test-access-token-1', 'test-access-token-2']);
		release();
		expect((await a).ok).toBe(true);

		// A's late 401 named token 1, so token 2 survived: A retried with it, and so does C.
		await commerce.createInquiry(inquiry, KEY);
		expect(backend.exchanges).toHaveLength(2);
		expect(
			backend.calls
				.slice(1, 4)
				.filter((c) => c.path === '/inquiries')
				.map((c) => c.headers.authorization)
		).toEqual([
			'Bearer test-access-token-1',
			'Bearer test-access-token-1',
			'Bearer test-access-token-2'
		]);
		expect(bearers().at(-1)).toBe('Bearer test-access-token-2');
	});

	it.each([
		[
			'POST /inquiries',
			'fionas.inquiries.create',
			(c: ReturnType<typeof client>) => c.createInquiry(inquiry, KEY)
		]
	])(
		'treats a 403 on %s as an outage and never refreshes for it',
		async (route, permission, call) => {
			const commerce = client();
			backend.revoke(permission);

			const result = await call(commerce);

			expect(result).toMatchObject({
				ok: false,
				error: { kind: 'service_auth', status: 503, code: 'unavailable' }
			});
			expect(backend.calls).toHaveLength(1);
			expect(backend.exchanges).toHaveLength(1);
			expect(logs.join('\n')).toContain(
				`[commerce] ${route} → 403; check fionas-web service permissions (needs ${permission})`
			);
			expect(JSON.stringify(result)).not.toMatch(/forbidden|permission|fionas\./);
			expectNoSecrets(result);
		}
	);

	it('treats an unusable token response as the backend being unavailable', async () => {
		const commerce = client(async (input, init) =>
			String(input).endsWith('/auth/service/token')
				? Response.json({ accessToken: 'test-access-token-x', tokenType: 'Bearer' })
				: backend.fetch(input, init)
		);
		const result = await commerce.createInquiry(inquiry, KEY);
		expect(result).toMatchObject({ ok: false, error: { kind: 'service_auth', status: 503 } });
		expect(backend.calls).toHaveLength(0);
		expectNoSecrets(result);
	});

	it('keeps a submission unknown when its retry could not even authenticate', async () => {
		let refuse = false;
		const commerce = client(async (input, init) => {
			if (refuse && String(input).endsWith('/auth/service/token')) {
				return Response.json({ code: 'unauthenticated', message: 'm' }, { status: 401 });
			}
			try {
				return await backend.fetch(input, init);
			} finally {
				if (String(input).endsWith('/inquiries')) {
					// The first delivery is lost in transit; then the service is locked out.
					backend.expireTokens();
					refuse = true;
				}
			}
		});
		backend.script('commit-then-drop');

		const result = await commerce.createInquiry(inquiry, KEY);

		// The first delivery may have committed (it did); "nothing was sent" would be untrue.
		expect(result).toMatchObject({ ok: false, error: { kind: 'timeout' } });
		expect(backend.posts()).toHaveLength(2);
		expect(backend.committed.size).toBe(1);
	});
});
