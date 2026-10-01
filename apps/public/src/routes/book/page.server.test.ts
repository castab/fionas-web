import { isRedirect, type Cookies } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InquiryForm } from '@fionas/shared';
import type { SubmissionFailure } from '$lib/inquiry-submission.js';
import {
	TEST_BASE_URL,
	TEST_UI_KEY,
	fakeCommerce,
	formFixture,
	type FakeCommerce
} from '$lib/server/testing/fake-commerce.js';

/*
 * Integration: a browser form post → this route's SvelteKit action → the server-only commerce
 * adapter → (fake) fionas-commerce over `fetch`. Only the network edge is replaced.
 */

const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));

const { actions, load } = await import('./+page.server.js');
const received = await import('./received/+page.server.js');

const ORIGIN = 'https://fionasicecream.com';

type Fields = Record<string, string | string[]>;

/** The answers a customer gives on the rendered fixture form, as the browser posts them. */
const priced: Fields = {
	name: 'Jane Doe',
	email: 'jane@example.com',
	zipCode: '02134',
	eventDate: '2026-12-05',
	eventType: 'BIRTHDAY',
	guestCount: '75',
	durationMinutes: '120',
	'offering:soft-serve-flavor': ['vanilla', 'horchata'],
	'offering:topping': ['sprinkles', 'oreos', 'strawberries', 'brownies'],
	'offering:cone-option': 'waffle-cone',
	message: '  Backyard birthday  '
};

function formData(token: string, revision: number, fields: Fields, extra: Fields = {}): FormData {
	const data = new FormData();
	data.append('submissionToken', token);
	data.append('catalogRevision', String(revision));
	for (const [name, value] of Object.entries({ ...fields, ...extra })) {
		for (const v of Array.isArray(value) ? value : [value]) data.append(name, v);
	}
	return data;
}

function cookieJar(): Cookies & { jar: Map<string, string> } {
	const jar = new Map<string, string>();
	return {
		jar,
		get: (name: string) => jar.get(name),
		getAll: () => [...jar].map(([name, value]) => ({ name, value })),
		set: (name: string, value: string) => void jar.set(name, value),
		delete: (name: string) => void jar.delete(name),
		serialize: () => ''
	};
}

let backend: FakeCommerce;
let cookies: ReturnType<typeof cookieJar>;
let warnings: string[];

beforeEach(() => {
	env.COMMERCE_API_URL = TEST_BASE_URL;
	env.COMMERCE_UI_API_KEY = TEST_UI_KEY;
	env.BOOKING_ENABLED = 'true';
	backend = fakeCommerce();
	vi.stubGlobal('fetch', vi.fn(backend.fetch));
	cookies = cookieJar();
	warnings = [];
	vi.spyOn(console, 'warn').mockImplementation((...args) => void warnings.push(args.join(' ')));
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** Loads /book the way a page view does. */
async function loadPage() {
	const headers: Record<string, string> = {};
	const event = { setHeaders: (h: Record<string, string>) => Object.assign(headers, h) };
	const data = (await load(event as never)) as {
		form: InquiryForm | null;
		submissionToken: string;
	};
	return { data, headers };
}

type Outcome =
	{ redirect: string; status: number } | { status: number; failure: SubmissionFailure };

/** One browser delivery of the form to the default action. */
async function post(data: FormData): Promise<Outcome> {
	const request = new Request(`${ORIGIN}/book`, { method: 'POST', body: data });
	try {
		const result = (await actions.default({
			request,
			cookies,
			url: new URL(request.url)
		} as never)) as { status: number; data: SubmissionFailure };
		return { status: result.status, failure: result.data };
	} catch (e) {
		if (isRedirect(e)) return { redirect: e.location, status: e.status };
		throw e;
	}
}

function receiptPage() {
	return received.load({ cookies, setHeaders: () => {} } as never) as { receipt: unknown };
}

const failureOf = (outcome: Outcome) => {
	if (!('failure' in outcome))
		throw new Error(`expected a failure, got ${JSON.stringify(outcome)}`);
	return outcome.failure;
};

describe('/book load', () => {
	it('fetches the form server-side and gives the page a submission token, never the key', async () => {
		const { data, headers } = await loadPage();

		expect(backend.calls).toEqual([
			expect.objectContaining({
				path: '/inquiry-form',
				headers: expect.objectContaining({ authorization: `Bearer ${TEST_UI_KEY}` })
			})
		]);
		expect(data.form?.catalogRevision).toBe(15);
		expect(data.submissionToken).toMatch(/^[0-9a-f-]{36}$/);
		expect(headers['cache-control']).toBe('private, no-store');

		const serialized = JSON.stringify(data);
		expect(serialized).not.toContain(TEST_UI_KEY);
		expect(serialized).not.toContain('Bearer');
		expect(serialized).not.toContain(TEST_BASE_URL);
	});

	it('gives every page view its own logical submission', async () => {
		const first = await loadPage();
		const second = await loadPage();
		expect(first.data.submissionToken).not.toBe(second.data.submissionToken);
	});
});

describe('/book submission', () => {
	it('sends the priced intent with the private key and the page token, then shows the receipt', async () => {
		const { data } = await loadPage();
		const outcome = await post(formData(data.submissionToken, 15, priced));

		expect(outcome).toEqual({ redirect: '/book/received', status: 303 });
		const [call] = backend.posts();
		expect(call?.headers).toMatchObject({
			authorization: `Bearer ${TEST_UI_KEY}`,
			'idempotency-key': data.submissionToken,
			'content-type': 'application/json'
		});
		// Exactly the semantic intent: no totals, prices, lines, document or customer ids.
		expect(call?.body).toEqual({
			name: 'Jane Doe',
			email: 'jane@example.com',
			message: 'Backyard birthday',
			zipCode: '02134',
			eventDate: '2026-12-05',
			eventType: 'BIRTHDAY',
			pricingInputs: {
				catalogRevision: 15,
				guestCount: 75,
				durationMinutes: 120,
				selections: [
					{ category: 'soft-serve-flavor', offerings: ['vanilla', 'horchata'] },
					{ category: 'topping', offerings: ['sprinkles', 'oreos', 'strawberries', 'brownies'] },
					{ category: 'cone-option', offerings: ['waffle-cone'] }
				]
			}
		});

		const receipt = backend.committed.get(data.submissionToken)?.receipt;
		expect(receiptPage()).toEqual({ receipt });
	});

	it('submits a plain inquiry when the form asks no pricing questions', async () => {
		const plain = formFixture();
		plain.sections = plain.sections.filter((s) => s.key !== 'service');
		delete plain.pricingPreview;
		backend.publish(plain);

		const { data } = await loadPage();
		const { name, email, zipCode, eventDate, eventType } = priced as Record<string, string>;
		const outcome = await post(
			formData(data.submissionToken, 15, { name, email, zipCode, eventDate, eventType })
		);

		expect(outcome).toMatchObject({ redirect: '/book/received' });
		expect(backend.posts()[0]?.body).toEqual({ name, email, zipCode, eventDate, eventType });
	});

	it('resolves a double delivery to one inquiry under one key', async () => {
		const { data } = await loadPage();
		const first = await post(formData(data.submissionToken, 15, priced));
		const firstReceipt = receiptPage();
		const second = await post(formData(data.submissionToken, 15, priced));

		expect(first).toEqual(second);
		expect(receiptPage()).toEqual(firstReceipt);
		expect(backend.posts().map((c) => c.headers['idempotency-key'])).toEqual([
			data.submissionToken,
			data.submissionToken
		]);
		expect(backend.committed.size).toBe(1);
	});

	it('retries a lost response with the same key and still shows the one receipt', async () => {
		const { data } = await loadPage();
		backend.script('commit-then-drop');

		expect(await post(formData(data.submissionToken, 15, priced))).toMatchObject({
			redirect: '/book/received'
		});
		expect(backend.posts().map((c) => c.headers['idempotency-key'])).toEqual([
			data.submissionToken,
			data.submissionToken
		]);
		expect(backend.committed.size).toBe(1);
		expect(receiptPage()).toEqual({
			receipt: backend.committed.get(data.submissionToken)?.receipt
		});
	});

	it('keeps the key through an outage so the customer can safely try again', async () => {
		const { data } = await loadPage();
		backend.script('commit-then-drop', 'network');

		const failure = failureOf(await post(formData(data.submissionToken, 15, priced)));
		expect(failure).toMatchObject({
			outcome: 'unavailable',
			submissionToken: data.submissionToken,
			catalogRevision: 15,
			answers: { values: expect.objectContaining({ name: 'Jane Doe' }) }
		});
		expect(failure.formError).toMatch(/won't create a duplicate/);

		// The customer presses Send again: same token, and the earlier commit comes back.
		expect(await post(formData(failure.submissionToken!, 15, priced))).toMatchObject({
			redirect: '/book/received'
		});
		const keys = new Set(backend.posts().map((c) => c.headers['idempotency-key']));
		expect([...keys]).toEqual([data.submissionToken]);
		expect(backend.committed.size).toBe(1);
	});

	it('reports an unexpected 5xx as recoverable without retrying it', async () => {
		const { data } = await loadPage();
		backend.script({ status: 500, body: { code: 'internal_failure', message: 'boom' } });

		const failure = failureOf(await post(formData(data.submissionToken, 15, priced)));
		expect(failure).toMatchObject({
			outcome: 'unavailable',
			submissionToken: data.submissionToken
		});
		expect(JSON.stringify(failure)).not.toContain('boom');
		expect(backend.posts()).toHaveLength(1);
	});

	it('presents a backend 422 as a form problem, in our own words', async () => {
		const { data } = await loadPage();
		backend.script({
			status: 422,
			body: {
				code: 'validation_failed',
				message: 'guestCount 75 cannot be priced (diagnostic)',
				violations: [{ code: 'INVALID_GUEST_COUNT' }]
			}
		});

		const outcome = await post(formData(data.submissionToken, 15, priced));
		expect(outcome.status).toBe(422);
		const failure = failureOf(outcome);
		expect(failure).toMatchObject({ outcome: 'rejected', submissionToken: data.submissionToken });
		expect(failure.formError).toMatch(/guest count isn't something we can price/);
		expect(failure.formError).not.toContain('diagnostic');
	});

	it('checks answers locally first and sends nothing when they are incomplete', async () => {
		const { data } = await loadPage();
		const outcome = await post(formData(data.submissionToken, 15, { ...priced, name: ' ' }));
		expect(failureOf(outcome)).toMatchObject({
			outcome: 'invalid',
			errors: { name: 'This field is required.' }
		});
		expect(backend.posts()).toHaveLength(0);
	});

	it('refuses a post without a usable submission token instead of inventing one', async () => {
		const outcome = await post(formData('', 15, priced));
		expect(outcome.status).toBe(400);
		expect(failureOf(outcome).outcome).toBe('malformed');
		expect(backend.calls).toHaveLength(0);
	});
});

describe('/book after a catalog change (CATALOG_REVISION_STALE)', () => {
	/** Revision 16: Horchata retired. */
	function republish() {
		const next = formFixture();
		next.catalogRevision = 16;
		for (const field of next.sections.flatMap((s) => s.fields)) {
			if (field.input.type === 'OFFERING_CHOICE') {
				field.input.options = field.input.options.filter((o) => o.key !== 'horchata');
			}
		}
		backend.publish(next);
	}

	it('refetches the form, keeps the customer details, drops retired choices and asks for review', async () => {
		const { data } = await loadPage();
		republish();

		const outcome = await post(formData(data.submissionToken, 15, priced));
		expect(outcome.status).toBe(409);
		const failure = failureOf(outcome);

		// The stale revision went to the backend as-is; nothing was resubmitted automatically.
		expect(backend.posts()).toHaveLength(1);
		expect(backend.posts()[0]?.body).toMatchObject({ pricingInputs: { catalogRevision: 15 } });
		// The form was read again past any cache after the conflict.
		const postIndex = backend.calls.findIndex((c) => c.method === 'POST');
		expect(backend.calls.slice(postIndex + 1)).toEqual([
			expect.objectContaining({
				path: '/inquiry-form',
				cache: 'no-store',
				headers: expect.objectContaining({ 'cache-control': 'no-cache' })
			})
		]);

		expect(failure.outcome).toBe('stale');
		expect(failure.refreshedForm?.catalogRevision).toBe(16);
		expect(failure.catalogRevision).toBe(16);
		expect(failure.answers?.values).toMatchObject({
			name: 'Jane Doe',
			email: 'jane@example.com',
			zipCode: '02134',
			eventDate: '2026-12-05',
			eventType: 'BIRTHDAY',
			guestCount: '75',
			'offering:soft-serve-flavor': ['vanilla']
		});
		expect(failure.reviewFields).toEqual(['Choose your soft serve flavors']);
		expect(failure.submissionToken).toMatch(/^[0-9a-f-]{36}$/);
		expect(failure.submissionToken).not.toBe(data.submissionToken);
		expect(backend.committed.size).toBe(0);
	});

	it('sends the reviewed form as a new submission under the new key', async () => {
		const { data } = await loadPage();
		republish();
		const failure = failureOf(await post(formData(data.submissionToken, 15, priced)));

		const reviewed = { ...priced, 'offering:soft-serve-flavor': ['vanilla', 'chocolate'] };
		const outcome = await post(formData(failure.submissionToken!, 16, reviewed));

		expect(outcome).toMatchObject({ redirect: '/book/received' });
		const last = backend.posts().at(-1);
		expect(last?.headers['idempotency-key']).toBe(failure.submissionToken);
		expect(last?.body).toMatchObject({ pricingInputs: { catalogRevision: 16 } });
	});

	it('still recovers an earlier commit of the same key after the catalog moved on', async () => {
		const { data } = await loadPage();
		backend.script('commit-then-drop', 'network');
		failureOf(await post(formData(data.submissionToken, 15, priced)));
		republish();

		// Same token and answers: the backend replays before checking the catalog.
		expect(await post(formData(data.submissionToken, 15, priced))).toMatchObject({
			redirect: '/book/received'
		});
		expect(backend.committed.size).toBe(1);
	});
});

describe('/book with a reused key (IDEMPOTENCY_KEY_REUSED)', () => {
	it('does not retry with a new key and lets the customer deliberately send a new request', async () => {
		const { data } = await loadPage();
		// The first delivery committed, but its response was lost twice; the customer then edits.
		backend.script('commit-then-drop', 'network');
		failureOf(await post(formData(data.submissionToken, 15, priced)));
		const before = backend.posts().length;

		const changed = { ...priced, guestCount: '90' };
		const outcome = await post(formData(data.submissionToken, 15, changed));

		expect(outcome.status).toBe(409);
		const failure = failureOf(outcome);
		expect(backend.posts()).toHaveLength(before + 1);
		expect(failure).toMatchObject({
			outcome: 'key_reused',
			submissionToken: data.submissionToken,
			answers: { values: expect.objectContaining({ guestCount: '90' }) }
		});
		expect(failure.formError).not.toMatch(/diagnostic/);
		expect(failure.restartToken).toMatch(/^[0-9a-f-]{36}$/);
		expect(failure.restartToken).not.toBe(data.submissionToken);
		expect(warnings.join('\n')).toMatch(/Idempotency-Key .* already used/);

		// "Send as a new request".
		const restart = await post(
			formData(data.submissionToken, 15, changed, { restartToken: failure.restartToken! })
		);
		expect(restart).toMatchObject({ redirect: '/book/received' });
		expect(backend.posts().at(-1)?.headers['idempotency-key']).toBe(failure.restartToken);
		expect(backend.committed.size).toBe(2);
	});
});

describe('/book/received', () => {
	it('sends a visitor without a receipt back to the form', () => {
		try {
			receiptPage();
			expect.unreachable();
		} catch (e) {
			expect(isRedirect(e) && e.location).toBe('/book');
		}
	});
});
