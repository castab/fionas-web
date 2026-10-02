import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createServiceTokenSource,
	failureDelay,
	refreshSkew,
	type ServiceTokenSource
} from './service-auth.js';

/*
 * The SERVICE token lifecycle on its own: lazy exchange, in-memory reuse, early refresh, one
 * exchange at a time, race-safe invalidation, and failures that never leak the credential. Time is
 * an injected clock; nothing sleeps.
 */

const BASE_URL = 'http://commerce.internal.test';
const SERVICE_ID = '00000000-0000-4000-8000-0000000000aa';
const CREDENTIAL = 'test-only-service-credential-not-a-secret';
const MINUTE = 60_000;

let clock: number;
let exchanges: { url: string; init: RequestInit; body: unknown }[];
let answer: (n: number) => Response | Promise<Response>;
let logs: string[];

const tokenBody = (n: number, expiresIn = 900) => ({
	accessToken: `opaque-token-${n}`,
	tokenType: 'Bearer',
	expiresAt: new Date(clock + expiresIn * 1000).toISOString(),
	expiresIn
});

const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
	exchanges.push({ url: String(input), init: init!, body: JSON.parse(String(init?.body)) });
	return answer(exchanges.length);
});

function source(overrides: { serviceId?: string; credential?: string } = {}): ServiceTokenSource {
	return createServiceTokenSource({
		baseUrl: BASE_URL,
		serviceId: SERVICE_ID,
		credential: CREDENTIAL,
		fetch: fakeFetch as typeof fetch,
		now: () => clock,
		...overrides
	});
}

beforeEach(() => {
	clock = Date.UTC(2026, 9, 1, 12);
	exchanges = [];
	answer = (n) => Response.json(tokenBody(n));
	logs = [];
	const capture = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
	vi.spyOn(console, 'error').mockImplementation(capture);
	vi.spyOn(console, 'warn').mockImplementation(capture);
});

afterEach(() => {
	fakeFetch.mockClear();
	vi.restoreAllMocks();
});

describe('acquisition', () => {
	it('exchanges nothing until a token is needed, then posts the credential once', async () => {
		const tokens = source();
		expect(exchanges).toHaveLength(0);

		expect(await tokens.token()).toEqual({ ok: true, accessToken: 'opaque-token-1' });
		expect(exchanges).toHaveLength(1);
		const [exchange] = exchanges;
		expect(exchange?.url).toBe(`${BASE_URL}/auth/service/token`);
		expect(exchange?.init).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'manual' });
		expect(new Headers(exchange?.init.headers).get('content-type')).toBe('application/json');
		expect(exchange?.body).toEqual({ serviceId: SERVICE_ID, secret: CREDENTIAL });
	});

	it('reuses the cached token for sequential callers', async () => {
		const tokens = source();
		await tokens.token();
		clock += 10 * MINUTE;
		expect(await tokens.token()).toEqual({ ok: true, accessToken: 'opaque-token-1' });
		expect(exchanges).toHaveLength(1);
	});

	it('uses the opaque token as given: no JWT decoding, expiry from the response', async () => {
		answer = () =>
			Response.json({
				...tokenBody(1, 120),
				accessToken: 'not.a-jwt.at_all~',
				tokenType: 'bearer'
			});
		expect(await source().token()).toEqual({ ok: true, accessToken: 'not.a-jwt.at_all~' });
	});
});

describe('one exchange at a time', () => {
	it('gives concurrent callers the result of a single exchange', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		answer = async (n) => {
			await gate;
			return Response.json(tokenBody(n));
		};
		const tokens = source();

		const waiting = Promise.all(Array.from({ length: 5 }, () => tokens.token()));
		release();
		const results = await waiting;

		expect(exchanges).toHaveLength(1);
		expect(new Set(results.map((r) => r.ok && r.accessToken))).toEqual(new Set(['opaque-token-1']));
	});

	it('releases a failed exchange, so a caller after the cooldown tries again', async () => {
		answer = (n) =>
			n === 1
				? Response.json({ code: 'unauthenticated', message: 'm' }, { status: 401 })
				: Response.json(tokenBody(n));
		const tokens = source();

		const first = await Promise.all([tokens.token(), tokens.token(), tokens.token()]);
		expect(first).toEqual([{ ok: false }, { ok: false }, { ok: false }]);
		expect(exchanges).toHaveLength(1);

		clock += failureDelay(1);
		expect(await tokens.token()).toEqual({ ok: true, accessToken: 'opaque-token-2' });
		expect(exchanges).toHaveLength(2);
	});

	it('releases an exchange that threw', async () => {
		answer = (n) => {
			if (n === 1) throw new TypeError('fetch failed');
			return Response.json(tokenBody(n));
		};
		const tokens = source();
		expect(await tokens.token()).toEqual({ ok: false });
		clock += failureDelay(1);
		expect(await tokens.token()).toEqual({ ok: true, accessToken: 'opaque-token-2' });
	});
});

describe('cooldown after a failed exchange', () => {
	const refused = () => Response.json({ code: 'unauthenticated', message: 'm' }, { status: 401 });

	it('suppresses sequential exchanges until the cooldown is over', async () => {
		answer = refused;
		const tokens = source();
		for (let i = 0; i < 4; i++) expect(await tokens.token()).toEqual({ ok: false });
		expect(exchanges).toHaveLength(1);

		clock += failureDelay(1) - 1;
		expect(await tokens.token()).toEqual({ ok: false });
		expect(exchanges).toHaveLength(1);
		clock += 1;
		expect(await tokens.token()).toEqual({ ok: false });
		expect(exchanges).toHaveLength(2);
	});

	it('lets exactly one exchange through when the cooldown ends, shared by concurrent callers', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		answer = async (n) => {
			if (n === 1) return refused();
			await gate;
			return Response.json(tokenBody(n));
		};
		const tokens = source();
		await tokens.token();

		clock += failureDelay(1);
		const waiting = Promise.all(Array.from({ length: 5 }, () => tokens.token()));
		release();
		const results = await waiting;
		expect(exchanges).toHaveLength(2);
		expect(results.every((r) => r.ok && r.accessToken === 'opaque-token-2')).toBe(true);
	});

	it('backs off 5, 10, 20, 40 and then at most 60 seconds between attempts', async () => {
		expect([1, 2, 3, 4, 5, 6, 20].map(failureDelay)).toEqual([
			5000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000
		]);

		answer = () => new Response(null, { status: 503 });
		const tokens = source();
		await tokens.token();
		for (const delay of [5000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
			const before = exchanges.length;
			clock += delay - 1;
			await tokens.token();
			expect(exchanges).toHaveLength(before);
			clock += 1;
			await tokens.token();
			expect(exchanges).toHaveLength(before + 1);
		}
	});

	it('starts from the base delay again after a success', async () => {
		answer = (n) => (n === 3 ? Response.json(tokenBody(n)) : refused());
		const tokens = source();
		await tokens.token(); // exchange 1 fails
		clock += failureDelay(1);
		await tokens.token(); // exchange 2 fails: the next delay doubles
		clock += failureDelay(2);
		expect(await tokens.token()).toEqual({ ok: true, accessToken: 'opaque-token-3' });

		tokens.invalidate('opaque-token-3');
		expect(await tokens.token()).toEqual({ ok: false }); // exchange 4 fails: base delay again
		clock += failureDelay(1);
		await tokens.token();
		expect(exchanges).toHaveLength(5);
	});

	it.each([
		['seconds', '30', 30_000],
		['seconds beyond the cap', '99999', 300_000]
	])('honors a 429 Retry-After in %s', async (_, header, wait) => {
		answer = () => new Response(null, { status: 429, headers: { 'retry-after': header } });
		const tokens = source();
		await tokens.token();
		clock += wait - 1;
		await tokens.token();
		expect(exchanges).toHaveLength(1);
		clock += 1;
		await tokens.token();
		expect(exchanges).toHaveLength(2);
	});

	it('uses the normal cooldown when Retry-After is unusable', async () => {
		answer = () =>
			new Response(null, {
				status: 429,
				headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }
			});
		const tokens = source();
		await tokens.token();
		clock += failureDelay(1);
		await tokens.token();
		expect(exchanges).toHaveLength(2);
	});

	it('keeps serving an unexpired token while refreshes fail and cool down', async () => {
		answer = (n) => (n === 1 ? Response.json(tokenBody(n)) : new Response(null, { status: 503 }));
		const tokens = source();
		await tokens.token();

		clock += 14.5 * MINUTE; // inside the refresh window
		expect(await tokens.token()).toEqual({ ok: true, accessToken: 'opaque-token-1' });
		expect(await tokens.token()).toEqual({ ok: true, accessToken: 'opaque-token-1' });
		expect(exchanges).toHaveLength(2); // the second call fell inside the cooldown

		clock += MINUTE; // expired: the next exchange fails too, and the one after is cooling down
		expect(await tokens.token()).toEqual({ ok: false });
		expect(await tokens.token()).toEqual({ ok: false });
		expect(exchanges).toHaveLength(3);
	});

	it('never brings back a refused token during a cooldown', async () => {
		answer = (n) => (n === 1 ? Response.json(tokenBody(n)) : new Response(null, { status: 503 }));
		const tokens = source();
		await tokens.token();
		tokens.invalidate('opaque-token-1');
		expect(await tokens.token()).toEqual({ ok: false });
		expect(await tokens.token()).toEqual({ ok: false });
		expect(exchanges).toHaveLength(2);
	});

	it('logs once per failed attempt, never per suppressed request', async () => {
		answer = refused;
		const tokens = source();
		for (let i = 0; i < 5; i++) await tokens.token();
		expect(logs).toHaveLength(1);
	});
});

describe('early refresh', () => {
	it('replaces a 15-minute token a minute before it expires', async () => {
		const tokens = source();
		await tokens.token();

		clock += 14 * MINUTE - 1;
		expect(await tokens.token()).toEqual({ ok: true, accessToken: 'opaque-token-1' });
		clock += 1;
		expect(await tokens.token()).toEqual({ ok: true, accessToken: 'opaque-token-2' });
		expect(exchanges).toHaveLength(2);
	});

	it('keeps a short-lived token usable for most of its life', async () => {
		answer = (n) => Response.json(tokenBody(n, 10));
		const tokens = source();
		await tokens.token();
		await tokens.token();
		expect(exchanges).toHaveLength(1);

		clock += 8_999;
		await tokens.token();
		expect(exchanges).toHaveLength(1);
		clock += 1;
		expect(await tokens.token()).toEqual({ ok: true, accessToken: 'opaque-token-2' });
	});

	it.each([
		[900_000, 60_000],
		[300_000, 30_000],
		[10_000, 1_000],
		[1_000, 500]
	])('refreshes a %ims token %ims early', (lifetime, skew) => {
		expect(refreshSkew(lifetime)).toBe(skew);
	});

	it('keeps using a still-valid token while a refresh fails, never one that has expired', async () => {
		answer = (n) =>
			n === 1 ? Response.json(tokenBody(n)) : new Response('unavailable', { status: 503 });
		const tokens = source();
		await tokens.token();

		clock += 14.5 * MINUTE;
		expect(await tokens.token()).toEqual({ ok: true, accessToken: 'opaque-token-1' });
		expect(exchanges).toHaveLength(2);

		clock += MINUTE;
		expect(await tokens.token()).toEqual({ ok: false });
	});
});

describe('invalidate', () => {
	it('forgets the token it is told was refused', async () => {
		const tokens = source();
		await tokens.token();
		tokens.invalidate('opaque-token-1');
		expect(await tokens.token()).toEqual({ ok: true, accessToken: 'opaque-token-2' });
	});

	it('keeps a newer token that another request already installed', async () => {
		const tokens = source();
		await tokens.token();
		tokens.invalidate('opaque-token-1');
		await tokens.token(); // another request refreshed: opaque-token-2 is current

		// A slow request that was refused with token 1 reports it now.
		tokens.invalidate('opaque-token-1');
		expect(await tokens.token()).toEqual({ ok: true, accessToken: 'opaque-token-2' });
		expect(exchanges).toHaveLength(2);
	});

	it('never falls back to a token that was refused', async () => {
		answer = (n) => (n === 1 ? Response.json(tokenBody(n)) : new Response(null, { status: 503 }));
		const tokens = source();
		await tokens.token();
		tokens.invalidate('opaque-token-1');
		expect(await tokens.token()).toEqual({ ok: false });
	});
});

describe('failures', () => {
	const allLogs = () => logs.join('\n');

	it('reports a refused credential for the operator, without the credential', async () => {
		answer = () =>
			Response.json(
				{ code: 'unauthenticated', message: 'Service authentication failed' },
				{ status: 401 }
			);
		expect(await source().token()).toEqual({ ok: false });
		expect(allLogs()).toMatch(
			/service token exchange failed → 401; check COMMERCE_SERVICE_ID \/ COMMERCE_SERVICE_CREDENTIAL/
		);
		expect(allLogs()).not.toContain(CREDENTIAL);
		expect(allLogs()).not.toContain('Service authentication failed');
	});

	it('reports an unreachable token endpoint', async () => {
		answer = () => {
			throw new TypeError('fetch failed');
		};
		expect(await source().token()).toEqual({ ok: false });
		expect(allLogs()).toMatch(/unreachable; check COMMERCE_API_URL/);
	});

	it.each([
		['an unreadable body', () => new Response('{"accessToken": "tru', { status: 200 })],
		['no access token', () => Response.json({ ...tokenBody(1), accessToken: '' })],
		['a token with whitespace', () => Response.json({ ...tokenBody(1), accessToken: 'a b' })],
		['another token type', () => Response.json({ ...tokenBody(1), tokenType: 'MAC' })],
		['no lifetime', () => Response.json({ ...tokenBody(1), expiresIn: undefined })],
		['a zero lifetime', () => Response.json({ ...tokenBody(1), expiresIn: 0 })],
		['a string lifetime', () => Response.json({ ...tokenBody(1), expiresIn: '900' })],
		['no expiry time', () => Response.json({ ...tokenBody(1), expiresAt: 'soon' })]
	])('treats a 200 with %s as unusable', async (_, respond) => {
		answer = respond;
		const tokens = source();
		expect(await tokens.token()).toEqual({ ok: false });
		expect(allLogs()).toMatch(/outside the contract/);
		expect(allLogs()).not.toContain('opaque-token');
		// Nothing was cached: the next caller after the cooldown exchanges again.
		answer = (n) => Response.json(tokenBody(n));
		clock += failureDelay(1);
		expect(await tokens.token()).toEqual({ ok: true, accessToken: 'opaque-token-2' });
	});

	it.each([
		[
			'no service id',
			{ serviceId: undefined },
			/COMMERCE_SERVICE_ID and COMMERCE_SERVICE_CREDENTIAL must be set/
		],
		['no credential', { credential: undefined }, /must be set/],
		['a service id that is not a UUID', { serviceId: 'fionas-web' }, /must be the UUID/]
	])('calls nothing with %s, and says so once', async (_, overrides, message) => {
		const tokens = source(overrides);
		expect(await tokens.token()).toEqual({ ok: false });
		expect(await tokens.token()).toEqual({ ok: false });
		expect(exchanges).toHaveLength(0);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatch(message);
	});
});
