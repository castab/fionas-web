import { isRedirect, type Cookies } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InquiryForm } from '@fionas/shared';
import type { SubmissionFailure } from '$lib/inquiry-submission.js';
import {
	TEST_BASE_URL,
	TEST_SERVICE_CREDENTIAL,
	TEST_SERVICE_ID,
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
const { resetCommerceClient } = await import('$lib/server/commerce.js');

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
	env.COMMERCE_SERVICE_ID = TEST_SERVICE_ID;
	env.COMMERCE_SERVICE_CREDENTIAL = TEST_SERVICE_CREDENTIAL;
	env.BOOKING_ENABLED = 'true';
	resetCommerceClient();
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

/** Nothing the browser receives may carry the service credential, its id or an access token. */
function expectNoSecrets(value: unknown) {
	const text = JSON.stringify(value);
	expect(text).not.toContain(TEST_SERVICE_CREDENTIAL);
	expect(text).not.toContain(TEST_SERVICE_ID);
	expect(text).not.toContain('test-access-token');
	expect(text).not.toContain('Bearer');
}

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

/** "Try sending again" after an unknown outcome: the frozen answers plus the delivered request. */
const retryOf = (failure: SubmissionFailure, fields: Fields = priced) =>
	formData(failure.submissionToken!, failure.catalogRevision!, fields, {
		outcomeUnknown: 'true',
		replayRequest: JSON.stringify(failure.replay!.request)
	});

const failureOf = (outcome: Outcome) => {
	if (!('failure' in outcome))
		throw new Error(`expected a failure, got ${JSON.stringify(outcome)}`);
	return outcome.failure;
};

describe('/book load', () => {
	it('fetches the form server-side as the site SERVICE and gives the page only a submission token', async () => {
		const { data, headers } = await loadPage();

		expect(backend.exchanges).toEqual([{ serviceId: TEST_SERVICE_ID, accepted: true }]);
		expect(backend.calls).toEqual([
			expect.objectContaining({
				path: '/inquiry-form',
				headers: expect.objectContaining({ authorization: `Bearer ${backend.tokens()[0]}` })
			})
		]);
		expect(data.form?.catalogRevision).toBe(15);
		expect(data.submissionToken).toMatch(/^[0-9a-f-]{36}$/);
		expect(headers['cache-control']).toBe('private, no-store');

		expectNoSecrets(data);
		expect(JSON.stringify(data)).not.toContain(TEST_BASE_URL);
	});

	it('reuses the server token across page views', async () => {
		await loadPage();
		await loadPage();
		expect(backend.exchanges).toHaveLength(1);
	});

	it('shows "unavailable" when the service may not read the form, without saying why', async () => {
		backend.revoke('fionas.inquiry-form.read');
		const { data } = await loadPage();
		expect(data.form).toBeNull();
		expect(backend.exchanges).toHaveLength(1);
		expectNoSecrets(data);
	});

	it('renders the version 7 definition as sent, service section required', async () => {
		const { data } = await loadPage();
		expect(data.form?.definitionVersion).toBe(7);
		expect(data.form?.sections.map((s) => [s.key, s.optional])).toEqual([
			['contact', false],
			['event', false],
			['service', false],
			['additional', true]
		]);
		expect(warnings).toEqual([]);
	});

	it('fails closed on a form outside the contract', async () => {
		const broken = formFixture() as unknown as { sections: { fields: { input: unknown }[] }[] };
		broken.sections[2]!.fields[0]!.input = { type: 'SLIDER', min: 1 };
		backend.publish(broken as unknown as InquiryForm);

		const { data } = await loadPage();
		expect(data.form).toBeNull();
	});

	it.each(['AVAILABLE', 'UNAVAILABLE'] as const)(
		'fails closed on a DISABLED (%s) offering, which the public form never lists',
		async (availability) => {
			const leaked = formFixture();
			const flavors = leaked.sections
				.flatMap((s) => s.fields)
				.find((f) => f.key === 'offering:soft-serve-flavor')!;
			if (flavors.input.type !== 'OFFERING_CHOICE') throw new Error('fixture changed');
			flavors.input.options[0] = {
				...flavors.input.options[0]!,
				selectionState: 'DISABLED',
				availability
			};
			backend.publish(leaked);

			// Not shown as "temporarily unavailable", not filtered out: the whole form is refused.
			const { data } = await loadPage();
			expect(data.form).toBeNull();
			const errors = vi.mocked(console.error).mock.calls.map((args) => args.join(' '));
			expect(errors.join('\n')).toMatch(/GET \/inquiry-form returned a body outside the contract/);
		}
	);

	it('gives every page view its own logical submission', async () => {
		const first = await loadPage();
		const second = await loadPage();
		expect(first.data.submissionToken).not.toBe(second.data.submissionToken);
	});
});

describe('/book submission', () => {
	it('sends the priced intent with the service token and the page token, then shows the receipt', async () => {
		const { data } = await loadPage();
		const outcome = await post(formData(data.submissionToken, 15, priced));

		expect(outcome).toEqual({ redirect: '/book/received', status: 303 });
		const [call] = backend.posts();
		expect(call?.headers).toMatchObject({
			authorization: `Bearer ${backend.tokens()[0]}`,
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
				guestCountIsMinimum: false,
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

	// Critical regression: definition version 7 has no plain/contact-only inquiry.
	it('refuses a contact-only submission and sends nothing', async () => {
		const { data } = await loadPage();
		const { name, email, zipCode, eventDate, eventType } = priced as Record<string, string>;
		const contactOnly = { name, email, zipCode, eventDate, eventType, message: 'Call me?' };

		const outcome = await post(formData(data.submissionToken, 15, contactOnly));

		expect(outcome.status).toBe(422);
		const failure = failureOf(outcome);
		expect(failure.outcome).toBe('invalid');
		expect(Object.keys(failure.errors ?? {}).sort()).toEqual([
			'durationMinutes',
			'guestCount',
			'offering:cone-option',
			'offering:soft-serve-flavor',
			'offering:topping'
		]);
		expect(failure.submissionToken).toBe(data.submissionToken);
		expect(backend.posts()).toHaveLength(0);
	});

	it('rejects a definition with an optional service section: no form, nothing sent', async () => {
		const drifted = formFixture();
		drifted.sections.find((s) => s.key === 'service')!.optional = true;
		backend.publish(drifted);

		const { data } = await loadPage();
		expect(data.form).toBeNull();
		expect(warnings.join(' ')).toMatch(
			/incompatible with POST \/inquiries \(section "service" has pricing questions but is marked optional\)/
		);

		// Not coerced into a required section: even a complete, priced submission is refused.
		const failure = failureOf(await post(formData(data.submissionToken, 15, priced)));
		expect(failure.outcome).toBe('unavailable');
		expect(failure.formError).toMatch(/hasn't been sent/);
		expect(backend.posts()).toHaveLength(0);
	});

	it('offers no refreshed form for review when the new definition is incompatible', async () => {
		const { data } = await loadPage();
		const drifted = formFixture();
		drifted.catalogRevision = 16;
		drifted.sections.find((s) => s.key === 'service')!.optional = true;
		// The submit-time read still sees revision 15; only the stale refresh sees the drifted form.
		backend.script({
			status: 409,
			body: { code: 'CATALOG_REVISION_STALE', message: 'diagnostic' }
		});
		const publishAfterPost = backend.fetch;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const response = await publishAfterPost(input, init);
				if (init?.method === 'POST') backend.publish(drifted);
				return response;
			})
		);

		const failure = failureOf(await post(formData(data.submissionToken, 15, priced)));

		expect(failure.outcome).toBe('stale');
		expect(failure.refreshedForm).toBeUndefined();
		expect(failure.formError).toMatch(/reload the page/);
		expect(backend.posts()).toHaveLength(1);
	});

	it('offers no form, and sends nothing, when the definition cannot produce pricingInputs', async () => {
		const noService = formFixture();
		noService.sections = noService.sections.filter((s) => s.key !== 'service');
		backend.publish(noService);

		const { data } = await loadPage();
		expect(data.form).toBeNull();

		const { name, email, zipCode, eventDate, eventType } = priced as Record<string, string>;
		const failure = failureOf(
			await post(formData(data.submissionToken, 15, { name, email, zipCode, eventDate, eventType }))
		);
		expect(failure.outcome).toBe('unavailable');
		expect(failure.formError).toMatch(/hasn't been sent/);
		expect(backend.posts()).toHaveLength(0);
	});

	it('requires the whole service configuration, not just part of it', async () => {
		const { data } = await loadPage();
		const { name, email, zipCode, eventDate, eventType } = priced as Record<string, string>;
		const started = { name, email, zipCode, eventDate, eventType, guestCount: '40' };

		const failure = failureOf(await post(formData(data.submissionToken, 15, started)));

		expect(failure.outcome).toBe('invalid');
		expect(Object.keys(failure.errors ?? {}).sort()).toEqual([
			'durationMinutes',
			'offering:cone-option',
			'offering:soft-serve-flavor',
			'offering:topping'
		]);
		expect(backend.posts()).toHaveLength(0);
	});

	it('refuses an unavailable choice locally and sends nothing', async () => {
		const { data } = await loadPage();
		const tampered = {
			...priced,
			'offering:topping': ['sprinkles', 'oreos', 'strawberries', 'gummy-bears']
		};

		const failure = failureOf(await post(formData(data.submissionToken, 15, tampered)));

		expect(failure).toMatchObject({ outcome: 'invalid', submissionToken: data.submissionToken });
		expect(failure.errors?.['offering:topping']).toMatch(/gummy-bears is unavailable right now/);
		expect(backend.posts()).toHaveLength(0);
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

	it('reports an unknown outcome as ambiguous and retries the identical request under the same key', async () => {
		const { data } = await loadPage();
		// Committed, then the response was lost on both of the server's deliveries.
		backend.script('commit-then-drop', 'network');

		const outcome = await post(formData(data.submissionToken, 15, priced));
		expect(outcome.status).toBe(503);
		const failure = failureOf(outcome);
		expect(failure).toMatchObject({
			outcome: 'ambiguous',
			submissionToken: data.submissionToken,
			catalogRevision: 15,
			answers: { values: expect.objectContaining({ name: 'Jane Doe' }) }
		});
		expect(failure.formError).toMatch(/couldn't confirm.*won't record it twice/);
		// A deliberate "change my answers" would be a new submission; it never replaces the retry key.
		expect(failure.restartToken).toMatch(/^[0-9a-f-]{36}$/);
		expect(failure.restartToken).not.toBe(data.submissionToken);
		// The page gets back the exact command it delivered, to resend as it is.
		expect(failure.replay?.request).toEqual(backend.posts()[0]?.body);
		expectNoSecrets(failure);

		// "Try sending again" posts that command back: same token, same body, the original receipt.
		const retry = await post(retryOf(failure));
		expect(retry).toMatchObject({ redirect: '/book/received' });
		const posts = backend.posts();
		expect(new Set(posts.map((c) => c.headers['idempotency-key']))).toEqual(
			new Set([data.submissionToken])
		);
		expect(new Set(posts.map((c) => JSON.stringify(c.body))).size).toBe(1);
		expect(backend.committed.size).toBe(1);
		expect(receiptPage()).toEqual({
			receipt: backend.committed.get(data.submissionToken)?.receipt
		});
	});

	it('keeps an unresolved submission ambiguous, with the same command, when the retry cannot even start', async () => {
		const { data } = await loadPage();
		backend.script('network', 'network');
		const failure = failureOf(await post(formData(data.submissionToken, 15, priced)));
		env.COMMERCE_SERVICE_CREDENTIAL = 'revoked-elsewhere';

		const retry = failureOf(await post(retryOf(failure)));
		expect(retry).toMatchObject({ outcome: 'ambiguous', submissionToken: data.submissionToken });
		expect(retry.replay).toEqual(failure.replay);
		expect(backend.posts()).toHaveLength(2);
		expectNoSecrets(retry);
	});

	it('reports a refused service credential as unavailable, with nothing sent', async () => {
		const { data } = await loadPage();
		env.COMMERCE_SERVICE_CREDENTIAL = 'revoked-elsewhere';

		const outcome = await post(formData(data.submissionToken, 15, priced));
		expect(outcome.status).toBe(503);
		const failure = failureOf(outcome);
		expect(failure).toMatchObject({
			outcome: 'unavailable',
			submissionToken: data.submissionToken
		});
		expect(failure.formError).toMatch(/hasn't been sent/);
		expect(failure.restartToken).toBeUndefined();
		expect(backend.posts()).toHaveLength(0);
		expect(JSON.stringify(failure)).not.toContain('revoked-elsewhere');
		expectNoSecrets(failure);
	});

	it('presents a final 403 as a service outage, never as a problem with the answers', async () => {
		const { data } = await loadPage();
		backend.revoke('fionas.inquiries.create');

		const outcome = await post(formData(data.submissionToken, 15, priced));

		expect(outcome.status).toBe(503);
		const failure = failureOf(outcome);
		expect(failure).toMatchObject({
			outcome: 'unavailable',
			submissionToken: data.submissionToken
		});
		expect(failure.formError).toMatch(/hasn't been sent/);
		expect(failure.errors).toBeUndefined();
		expect(JSON.stringify(failure)).not.toMatch(/forbidden|permission|fionas\./i);
		// Authenticated but not permitted: a new token can't help, so none was requested.
		expect(backend.posts()).toHaveLength(1);
		expect(backend.exchanges).toHaveLength(1);
	});

	it('recovers from an expired token mid-submission with the same key and body', async () => {
		const { data } = await loadPage();
		// The token dies just as the inquiry is sent (after the form was read with it).
		const deliver = backend.fetch;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input).endsWith('/inquiries') && backend.posts().length === 0) {
					backend.expireTokens();
				}
				return deliver(input, init);
			})
		);

		expect(await post(formData(data.submissionToken, 15, priced))).toMatchObject({
			redirect: '/book/received'
		});
		const posts = backend.posts();
		expect(posts.map((c) => c.headers.authorization)).toEqual([
			`Bearer ${backend.tokens()[0]}`,
			`Bearer ${backend.tokens()[1]}`
		]);
		expect(posts.map((c) => c.headers['idempotency-key'])).toEqual([
			data.submissionToken,
			data.submissionToken
		]);
		expect(posts[1]?.body).toEqual(posts[0]?.body);
		expect(backend.committed.size).toBe(1);
	});

	describe('a persistent 500 (it may have committed)', () => {
		const internal = { status: 500, body: { code: 'internal_failure', message: 'boom' } };

		it('is ambiguous: same token, the exact request kept for replay, nothing editable', async () => {
			const { data } = await loadPage();
			backend.script(internal, internal);

			const outcome = await post(formData(data.submissionToken, 15, priced));

			expect(outcome.status).toBe(503);
			const failure = failureOf(outcome);
			expect(failure).toMatchObject({
				outcome: 'ambiguous',
				submissionToken: data.submissionToken,
				catalogRevision: 15
			});
			expect(failure.errors).toBeUndefined();
			// The server already retried once under the same key, with the same body.
			const posts = backend.posts();
			expect(posts.map((c) => c.headers['idempotency-key'])).toEqual([
				data.submissionToken,
				data.submissionToken
			]);
			expect(failure.replay?.request).toEqual(posts[0]?.body);
			expect(failure.formError).toMatch(/couldn't confirm/);
			expect(JSON.stringify(failure)).not.toContain('boom');
			expectNoSecrets(failure);
		});

		it('resends exactly that request under that key, and gets the receipt', async () => {
			const { data } = await loadPage();
			backend.script(internal, internal);
			const failure = failureOf(await post(formData(data.submissionToken, 15, priced)));

			expect(await post(retryOf(failure))).toMatchObject({ redirect: '/book/received' });
			const posts = backend.posts();
			expect(posts).toHaveLength(3);
			expect(new Set(posts.map((c) => c.headers['idempotency-key']))).toEqual(
				new Set([data.submissionToken])
			);
			expect(new Set(posts.map((c) => JSON.stringify(c.body))).size).toBe(1);
			expect(backend.committed.size).toBe(1);
		});

		it('recovers the receipt of a commit hidden behind the 500s', async () => {
			const { data } = await loadPage();
			backend.script('commit-then-500', internal);
			const failure = failureOf(await post(formData(data.submissionToken, 15, priced)));
			expect(failure.outcome).toBe('ambiguous');

			expect(await post(retryOf(failure))).toMatchObject({ redirect: '/book/received' });
			expect(backend.committed.size).toBe(1);
			expect(receiptPage()).toEqual({
				receipt: backend.committed.get(data.submissionToken)?.receipt
			});
		});

		it('never lets edited answers become request B under key K', async () => {
			const { data } = await loadPage();
			backend.script('commit-then-500', internal);
			const failure = failureOf(await post(formData(data.submissionToken, 15, priced)));

			// The visible answers are edited (as only a tampered page could), then "Try sending again".
			const edited = { ...priced, guestCount: '300', message: 'Changed' };
			expect(await post(retryOf(failure, edited))).toMatchObject({ redirect: '/book/received' });

			const bodies = backend.posts().map((c) => JSON.stringify(c.body));
			expect(new Set(bodies).size).toBe(1);
			expect(bodies[0]).not.toContain('Changed');
			expect(backend.committed.size).toBe(1);
		});

		it('sends changed answers only as a new submission under the restart key', async () => {
			const { data } = await loadPage();
			backend.script('commit-then-500', internal);
			const failure = failureOf(await post(formData(data.submissionToken, 15, priced)));

			// "Change my answers": the page switches to `restartToken` and drops the replay.
			const changed = { ...priced, guestCount: '90' };
			const outcome = await post(formData(failure.restartToken!, 15, changed));

			expect(outcome).toMatchObject({ redirect: '/book/received' });
			const last = backend.posts().at(-1);
			expect(last?.headers['idempotency-key']).toBe(failure.restartToken);
			expect(last?.headers['idempotency-key']).not.toBe(data.submissionToken);
			expect(last?.body).toMatchObject({ pricingInputs: { guestCount: 90 } });
			expect(backend.committed.get(data.submissionToken)?.fingerprint).not.toBe(
				JSON.stringify(last?.body)
			);
		});
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
	/**
	 * Revision 16. `disabled`: Horchata is disabled, so the public form omits it. `unavailable`:
	 * Horchata is still listed but temporarily UNAVAILABLE.
	 */
	function republish(horchata: 'disabled' | 'unavailable' = 'disabled') {
		const next = formFixture();
		next.catalogRevision = 16;
		for (const field of next.sections.flatMap((s) => s.fields)) {
			if (field.input.type === 'OFFERING_CHOICE') {
				field.input.options =
					horchata === 'disabled'
						? field.input.options.filter((o) => o.key !== 'horchata')
						: field.input.options.map((o) =>
								o.key === 'horchata' ? { ...o, availability: 'UNAVAILABLE' as const } : o
							);
			}
		}
		backend.publish(next);
		return next;
	}

	it('refetches the form, keeps the customer details, drops disabled choices and asks for review', async () => {
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
		// A disabled option is simply gone: counted, never named or described.
		expect(failure.unavailableChoices).toEqual([]);
		expect(failure.removedChoices).toBe(1);
		expect(failure.submissionToken).toMatch(/^[0-9a-f-]{36}$/);
		expect(failure.submissionToken).not.toBe(data.submissionToken);
		expect(backend.committed.size).toBe(0);
	});

	/** Revision 16 no longer offers the 120-minute service the customer chose. */
	function republishWithout120() {
		const next = formFixture();
		next.catalogRevision = 16;
		const duration = next.sections
			.flatMap((s) => s.fields)
			.find((f) => f.key === 'durationMinutes');
		if (duration?.input.type === 'INTEGER_CHOICE') {
			duration.input.options = duration.input.options.filter((o) => o.value !== 120);
		}
		backend.publish(next);
	}

	it('asks for review, without sending, when older answers no longer fit the service questions', async () => {
		const { data } = await loadPage();
		republishWithout120();

		const failure = failureOf(await post(formData(data.submissionToken, 15, priced)));

		expect(failure.outcome).toBe('stale');
		expect(failure.answers?.values.durationMinutes).toBe('');
		expect(failure.reviewFields).toEqual(['How long would you like service?']);
		expect(failure.submissionToken).not.toBe(data.submissionToken);
		expect(backend.posts()).toHaveLength(0);
	});

	it("replays an unresolved submission even when today's form no longer offers its answers", async () => {
		const { data } = await loadPage();
		backend.script('network', 'network'); // never reached the backend: nothing committed
		const failure = failureOf(await post(formData(data.submissionToken, 15, priced)));
		republishWithout120();

		const outcome = failureOf(await post(retryOf(failure)));

		// The delivered command went again as it was (120 minutes, revision 15), and the backend
		// settled it: stale, so the customer reviews today's form under a new key.
		const retried = backend.posts().at(-1);
		expect(retried?.headers['idempotency-key']).toBe(data.submissionToken);
		expect(retried?.body).toEqual(failure.replay?.request);
		expect(retried?.body).toMatchObject({
			pricingInputs: { catalogRevision: 15, durationMinutes: 120 }
		});
		expect(outcome.outcome).toBe('stale');
		expect(outcome.refreshedForm?.catalogRevision).toBe(16);
		expect(outcome.reviewFields).toEqual(['How long would you like service?']);
		expect(outcome.submissionToken).not.toBe(data.submissionToken);
		expect(outcome.replay).toBeUndefined();
	});

	it('keeps a newly unavailable choice listed but unselects it and says so', async () => {
		const { data } = await loadPage();
		republish('unavailable');
		const onlyHorchata = { ...priced, 'offering:soft-serve-flavor': ['horchata'] };

		const failure = failureOf(await post(formData(data.submissionToken, 15, onlyHorchata)));

		expect(failure.outcome).toBe('stale');
		const flavors = failure.refreshedForm?.sections
			.flatMap((s) => s.fields)
			.find((f) => f.key === 'offering:soft-serve-flavor');
		const horchata =
			flavors?.input.type === 'OFFERING_CHOICE'
				? flavors.input.options.find((o) => o.key === 'horchata')
				: undefined;
		expect(horchata).toMatchObject({ selectionState: 'ENABLED', availability: 'UNAVAILABLE' });
		// Unselected, never swapped for another flavor; the minimum now asks the customer to choose.
		expect(failure.answers?.values['offering:soft-serve-flavor']).toEqual([]);
		expect(failure.unavailableChoices).toEqual(['Horchata']);
		expect(failure.removedChoices).toBe(0);
		expect(failure.reviewFields).toEqual(['Choose your soft serve flavors']);
		expect(failure.submissionToken).not.toBe(data.submissionToken);
		expect(backend.posts()).toHaveLength(1);
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

/*
 * One Idempotency-Key names one immutable CreateInquiryRequest. After an unknown outcome the page
 * resends the command that was delivered, never one rebuilt from a newer form, and the backend's
 * idempotency and stale-catalog rules settle it.
 */
describe('/book exact replay after an unknown outcome', () => {
	/** Revision 16: a new revision whose form also changed (no more 120-minute service). */
	function publishRevision16() {
		const next = formFixture();
		next.catalogRevision = 16;
		const duration = next.sections
			.flatMap((s) => s.fields)
			.find((f) => f.key === 'durationMinutes');
		if (duration?.input.type === 'INTEGER_CHOICE') {
			duration.input.options = duration.input.options.filter((o) => o.value !== 120);
		}
		backend.publish(next);
	}

	/** Loads revision 15, delivers request A under key K, and ends with an unknown outcome. */
	async function ambiguous(committed: boolean) {
		const { data } = await loadPage();
		backend.script(committed ? 'commit-then-drop' : 'network', 'network');
		const failure = failureOf(await post(formData(data.submissionToken, 15, priced)));
		expect(failure.outcome).toBe('ambiguous');
		const delivered = backend.posts()[0]!;
		return { key: data.submissionToken, failure, delivered };
	}

	/** Backend calls made by the retry, in order. */
	async function retry(failure: SubmissionFailure, fields: Fields = priced) {
		const before = backend.calls.length;
		const outcome = await post(retryOf(failure, fields));
		return { outcome, calls: backend.calls.slice(before) };
	}

	it('resends exactly request A under key K and gets the original receipt', async () => {
		const { key, failure, delivered } = await ambiguous(true);
		const { outcome, calls } = await retry(failure);

		expect(outcome).toMatchObject({ redirect: '/book/received' });
		expect(calls[0]).toMatchObject({ method: 'POST', path: '/inquiries' });
		expect(calls[0]?.headers['idempotency-key']).toBe(key);
		expect(calls[0]?.body).toEqual(delivered.body);
		expect(JSON.stringify(calls[0]?.body)).toBe(JSON.stringify(delivered.body));
		expect(backend.committed.size).toBe(1);
	});

	// The main regression this replay exists for: steps 1-7, then both backend outcomes.
	it.each([
		['committed earlier: the original receipt', true],
		['never committed: stale, review under a new key', false]
	])('replays A/K unchanged after revision 16 changed the form (%s)', async (_, committed) => {
		const { key, failure, delivered } = await ambiguous(committed);
		publishRevision16();

		const { outcome, calls } = await retry(failure);

		// No current-form rewriting before the replay: the first backend call is the POST itself.
		expect(calls[0]).toMatchObject({ method: 'POST', path: '/inquiries' });
		expect(calls[0]?.headers['idempotency-key']).toBe(key);
		expect(calls[0]?.body).toEqual(delivered.body);
		expect(calls[0]?.body).toMatchObject({ pricingInputs: { catalogRevision: 15 } });
		expect(calls.filter((c) => c.path === '/inquiries')).toHaveLength(1);

		if (committed) {
			expect(outcome).toMatchObject({ redirect: '/book/received' });
			expect(receiptPage()).toEqual({ receipt: backend.committed.get(key)?.receipt });
			expect(backend.committed.size).toBe(1);
		} else {
			const review = failureOf(outcome);
			expect(review.outcome).toBe('stale');
			expect(review.refreshedForm?.catalogRevision).toBe(16);
			expect(review.catalogRevision).toBe(16);
			expect(review.submissionToken).not.toBe(key);
			expect(review.replay).toBeUndefined();
			expect(backend.committed.size).toBe(0);
		}
	});

	it('resends A even if the visible answers were tampered with', async () => {
		const { key, failure, delivered } = await ambiguous(false);
		const { calls } = await retry(failure, { ...priced, guestCount: '500', name: 'Someone Else' });
		expect(calls[0]?.headers['idempotency-key']).toBe(key);
		expect(calls[0]?.body).toEqual(delivered.body);
	});

	it('keeps the same A/K, with only a new service token, when the replay meets a 401', async () => {
		const { key, failure, delivered } = await ambiguous(true);
		backend.expireTokens();

		const { outcome, calls } = await retry(failure);

		expect(outcome).toMatchObject({ redirect: '/book/received' });
		const posts = calls.filter((c) => c.path === '/inquiries');
		expect(posts).toHaveLength(2);
		expect(posts.map((c) => c.headers['idempotency-key'])).toEqual([key, key]);
		expect(posts.map((c) => c.body)).toEqual([delivered.body, delivered.body]);
		expect(posts[0]?.headers.authorization).not.toBe(posts[1]?.headers.authorization);
	});

	it('stays unknown with the same command when the replay is lost again', async () => {
		const { key, failure } = await ambiguous(false);
		backend.script('network', 'network');
		const again = failureOf((await retry(failure)).outcome);
		expect(again).toMatchObject({ outcome: 'ambiguous', submissionToken: key });
		expect(again.replay).toEqual(failure.replay);
	});

	it.each([
		['not JSON', '{"name":'],
		['an empty value', ''],
		['an amount riding along', { total: '1.00' }],
		['a property inside pricingInputs', { pricingInputs: { subtotal: '1.00' } }],
		['an unknown event type', { eventType: 'PARADE' }],
		['a zero guest count', { pricingInputs: { guestCount: 0 } }],
		['a fractional duration', { pricingInputs: { durationMinutes: 120.5 } }],
		['selections that are not lists', { pricingInputs: { selections: 'vanilla' } }],
		['no email', { email: undefined }]
	])('sends nothing for a replay with %s', async (_, tamper) => {
		const { key, failure } = await ambiguous(false);
		const request = failure.replay!.request as unknown as Record<string, unknown>;
		const replayRequest =
			typeof tamper === 'string'
				? tamper
				: JSON.stringify({
						...request,
						...tamper,
						pricingInputs: {
							...(request.pricingInputs as object),
							...((tamper as { pricingInputs?: object }).pricingInputs ?? {})
						}
					});
		const before = backend.posts().length;

		const outcome = await post(
			formData(key, 15, priced, { outcomeUnknown: 'true', replayRequest })
		);

		expect(backend.posts()).toHaveLength(before);
		const refused = failureOf(outcome);
		expect(refused.outcome).toBe('ambiguous');
		expect(refused.submissionToken).toBe(key);
		expect(refused.replay).toBeUndefined();
		expect(refused.formError).toMatch(/couldn't safely resend your earlier request/);
		expect(refused.restartToken).toMatch(/^[0-9a-f-]{36}$/);
		expect(JSON.stringify(refused)).not.toMatch(/JSON|SyntaxError|Unexpected|position/);
	});

	it('sends nothing for an unresolved retry without a replay at all', async () => {
		const { key } = await ambiguous(false);
		const outcome = await post(formData(key, 15, priced, { outcomeUnknown: 'true' }));
		expect(backend.posts()).toHaveLength(2);
		expect(failureOf(outcome).formError).toMatch(/couldn't safely resend/);
	});

	it('drops the old command when the customer deliberately sends a new request', async () => {
		const { key, failure } = await ambiguous(false);
		const changed = { ...priced, guestCount: '90' };

		const outcome = await post(
			formData(key, 15, changed, {
				restartToken: failure.restartToken!,
				outcomeUnknown: 'true',
				replayRequest: JSON.stringify(failure.replay!.request)
			})
		);

		expect(outcome).toMatchObject({ redirect: '/book/received' });
		const last = backend.posts().at(-1);
		expect(last?.headers['idempotency-key']).toBe(failure.restartToken);
		expect(last?.body).toMatchObject({ pricingInputs: { guestCount: 90 } });
	});
});

describe('/book when the backend refuses the options (422 catalog-state violations)', () => {
	it('refreshes the form for review under a new key instead of resubmitting', async () => {
		const { data } = await loadPage();
		backend.script({
			status: 422,
			body: {
				code: 'validation_failed',
				message: 'offering horchata is unavailable (diagnostic)',
				violations: [{ code: 'OFFERING_UNAVAILABLE' }]
			}
		});

		const outcome = await post(formData(data.submissionToken, 15, priced));

		expect(outcome.status).toBe(422);
		const failure = failureOf(outcome);
		expect(failure.outcome).toBe('rejected');
		expect(failure.refreshedForm?.catalogRevision).toBe(15);
		expect(failure.submissionToken).not.toBe(data.submissionToken);
		expect(failure.answers?.values.name).toBe('Jane Doe');
		expect(JSON.stringify(failure)).not.toContain('diagnostic');
		// One delivery only, then a cache-bypassing form read; never an automatic resubmit.
		expect(backend.posts()).toHaveLength(1);
		expect(backend.calls.at(-1)).toMatchObject({ path: '/inquiry-form', cache: 'no-store' });
		expect(warnings.join('\n')).toMatch(/OFFERING_UNAVAILABLE/);
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
		expect(failure.formError).toBe(
			"We couldn't safely verify this submission. Please restart the request or contact us if you're unsure whether it was received."
		);
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
