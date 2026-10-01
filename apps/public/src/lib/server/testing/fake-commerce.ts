import { readFileSync } from 'node:fs';
import type { EstimatePreview, InquiryForm, PricingInputs } from '@fionas/shared';

/*
 * Test double for the fionas-commerce HTTP API, installed as `fetch`. It keeps the contract the
 * public app relies on: Bearer-protected UI endpoints, and POST /inquiries idempotency (same key +
 * same body replays the original 201 receipt, same key + different body is IDEMPOTENCY_KEY_REUSED,
 * an old catalog revision is CATALOG_REVISION_STALE, a pick the current form doesn't offer or lists
 * as UNAVAILABLE is 422 UNKNOWN_OFFERING / OFFERING_UNAVAILABLE, failures consume nothing). Test-only.
 */

export const TEST_UI_KEY = 'test-ui-secret-7f3a';
export const TEST_BASE_URL = 'http://commerce.internal.test';

/** The real form captured from fionas-commerce (also served by the e2e stub). */
export const formFixture = (): InquiryForm =>
	JSON.parse(
		readFileSync(new URL('../../../../e2e/fixtures/inquiry-form.json', import.meta.url), 'utf8')
	) as InquiryForm;

/** The real POST /estimate-preview answer captured for the fixture form. */
export const estimateFixture = (): EstimatePreview =>
	JSON.parse(
		readFileSync(new URL('../../../../e2e/fixtures/estimate-preview.json', import.meta.url), 'utf8')
	) as EstimatePreview;

export type RecordedCall = {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: unknown;
	cache?: RequestCache;
};

/** A one-off answer to the next POST /inquiries, overriding the contract behavior. */
export type Scripted =
	| { status: number; body?: unknown }
	/** The connection fails before the backend sees the request. */
	| 'network'
	/** The backend commits, then the response is lost (reset / timeout). */
	| 'commit-then-drop'
	/** The backend commits and answers 201 with a body that cannot be parsed. */
	| 'commit-then-garble';

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});

export function fakeCommerce(initialForm: InquiryForm = formFixture()) {
	const calls: RecordedCall[] = [];
	const committed = new Map<
		string,
		{ fingerprint: string; receipt: { id: string; createdAt: string } }
	>();
	const scripted: Scripted[] = [];
	let form = initialForm;
	let sequence = 0;

	function commit(key: string, body: unknown) {
		sequence += 1;
		const receipt = {
			id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
			createdAt: `2026-09-30T18:00:${String(sequence).padStart(2, '0')}.000000Z`
		};
		committed.set(key, { fingerprint: JSON.stringify(body), receipt });
		return receipt;
	}

	/** The backend's structural check of selections against the current catalog. */
	function offeringViolation(pricing: PricingInputs): string | null {
		const options = form.sections
			.flatMap((s) => s.fields)
			.flatMap((f) => (f.input.type === 'OFFERING_CHOICE' ? f.input.options : []));
		for (const { category, offerings } of pricing.selections) {
			for (const key of offerings) {
				const option = options.find((o) => o.category === category && o.key === key);
				if (!option) return 'UNKNOWN_OFFERING';
				if (option.availability !== 'AVAILABLE') return 'OFFERING_UNAVAILABLE';
			}
		}
		return null;
	}

	function createInquiry(headers: Record<string, string>, body: unknown): Response | 'drop' {
		const key = headers['idempotency-key'];
		if (!key || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) {
			return json(400, { code: 'malformed_request', message: 'Malformed request: header' });
		}
		const next = scripted.shift();
		if (next === 'network') throw new TypeError('fetch failed');
		if (next === 'commit-then-drop') {
			commit(key, body);
			return 'drop';
		}
		if (next === 'commit-then-garble') {
			commit(key, body);
			return new Response('{"id": "trunc', { status: 201 });
		}
		if (next) return json(next.status, next.body ?? {});

		const pricing = (body as { pricingInputs?: PricingInputs } | undefined)?.pricingInputs;
		// Definition version 7: every inquiry is configured service. No pricingInputs, no inquiry.
		if (typeof pricing !== 'object' || pricing === null) {
			return json(400, {
				code: 'malformed_request',
				message: 'Malformed request: body (diagnostic)'
			});
		}

		const fingerprint = JSON.stringify(body);
		const prior = committed.get(key);
		if (prior) {
			if (prior.fingerprint !== fingerprint) {
				return json(409, {
					code: 'IDEMPOTENCY_KEY_REUSED',
					message: 'Idempotency key was already used for a different inquiry (diagnostic)'
				});
			}
			return json(201, prior.receipt);
		}
		if (pricing.catalogRevision !== form.catalogRevision) {
			return json(409, {
				code: 'CATALOG_REVISION_STALE',
				message: `Catalog revision r${pricing.catalogRevision} is stale (diagnostic)`
			});
		}
		const violation = offeringViolation(pricing);
		if (violation) {
			return json(422, {
				code: 'validation_failed',
				message: `${violation} (diagnostic)`,
				violations: [{ code: violation }]
			});
		}
		return json(201, commit(key, body));
	}

	const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		const headers = Object.fromEntries(new Headers(init?.headers).entries());
		const method = init?.method ?? 'GET';
		const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
		calls.push({ method, path: url.pathname, headers, body, cache: init?.cache });

		if (url.origin !== TEST_BASE_URL) throw new TypeError(`unexpected host ${url.origin}`);
		if (headers.authorization !== `Bearer ${TEST_UI_KEY}`) {
			return json(401, { code: 'unauthenticated', message: 'Authentication is required' });
		}
		if (method === 'GET' && url.pathname === '/inquiry-form') return json(200, form);
		if (method === 'POST' && url.pathname === '/estimate-preview') {
			const next = scripted.shift();
			if (next && typeof next === 'object') return json(next.status, next.body ?? {});
			return json(200, estimateFixture());
		}
		if (method === 'POST' && url.pathname === '/inquiries') {
			const result = createInquiry(headers, body);
			if (result === 'drop') throw new DOMException('The operation timed out.', 'TimeoutError');
			return result;
		}
		return json(404, { code: 'not_found', message: 'Not found' });
	};

	return {
		fetch,
		calls,
		committed,
		/** Queue one-off answers for the next POST /inquiries (or /estimate-preview) calls. */
		script: (...next: Scripted[]) => scripted.push(...next),
		/** Publish a new catalog: later GET /inquiry-form calls see it, older revisions go stale. */
		publish: (next: InquiryForm) => (form = next),
		posts: () => calls.filter((c) => c.method === 'POST' && c.path === '/inquiries')
	};
}

export type FakeCommerce = ReturnType<typeof fakeCommerce>;
