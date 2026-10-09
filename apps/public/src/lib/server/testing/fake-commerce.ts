import { readFileSync } from 'node:fs';
import type { InquiryForm } from '@fionas/shared';

/** Test-only SERVICE auth and immutable priced-command idempotency double.
 * Synthetic credentials below never belong in deployed configuration. */

export const TEST_SERVICE_ID = '00000000-0000-4000-8000-0000000000aa';
export const TEST_SERVICE_CREDENTIAL = 'test-only-service-credential-not-a-secret';
export const TEST_BASE_URL = 'http://commerce.internal.test';

/** Synthetic public projection used only by tests. */
export const formFixture = (): InquiryForm =>
	JSON.parse(
		readFileSync(new URL('../../../../e2e/fixtures/inquiry-form.json', import.meta.url), 'utf8')
	) as InquiryForm;

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
	| 'commit-then-garble'
	/** The backend commits, then fails before answering: a 500 that hides a recorded inquiry. */
	| 'commit-then-500';

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});

/** The one public SERVICE permission. */
const PERMISSIONS: Record<string, string> = {
	'POST /inquiries': 'fionas.inquiries.create'
};

export function fakeCommerce() {
	/** Calls to the protected API (token exchanges are in `exchanges`). */
	const calls: RecordedCall[] = [];
	/** Every POST /auth/service/token, and whether the credential was accepted. */
	const exchanges: { serviceId: unknown; accepted: boolean }[] = [];
	/** Access tokens issued so far, in order; `live` holds the ones the backend still accepts. */
	const issued: string[] = [];
	const live = new Set<string>();
	/** Permissions the service's role grants right now (resolved live on every request). */
	const granted = new Set(Object.values(PERMISSIONS));
	const committed = new Map<
		string,
		{ fingerprint: string; receipt: { id: string; createdAt: string } }
	>();
	const scripted: Scripted[] = [];
	let sequence = 0;
	let tokenLifetimeSeconds = 900;

	function commit(key: string, body: unknown) {
		sequence += 1;
		const receipt = {
			id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
			createdAt: `2026-09-30T18:00:${String(sequence).padStart(2, '0')}.000000Z`
		};
		committed.set(key, { fingerprint: JSON.stringify(body), receipt });
		return receipt;
	}

	function issueToken(body: unknown): Response {
		const { serviceId, secret } = (body ?? {}) as { serviceId?: unknown; secret?: unknown };
		const accepted = serviceId === TEST_SERVICE_ID && secret === TEST_SERVICE_CREDENTIAL;
		exchanges.push({ serviceId, accepted });
		if (!accepted) {
			return json(401, { code: 'unauthenticated', message: 'Service authentication failed' });
		}
		const accessToken = `test-access-token-${issued.length + 1}`;
		issued.push(accessToken);
		live.add(accessToken);
		return json(200, {
			accessToken,
			tokenType: 'Bearer',
			expiresAt: new Date(Date.now() + tokenLifetimeSeconds * 1000).toISOString(),
			expiresIn: tokenLifetimeSeconds
		});
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
		if (next === 'commit-then-500') {
			commit(key, body);
			return json(500, { code: 'internal_failure', message: 'The request could not be completed' });
		}
		if (next) return json(next.status, next.body ?? {});

		if (
			!(body as { requestedService?: unknown })?.requestedService ||
			!Array.isArray((body as { lines?: unknown })?.lines)
		)
			return json(400, { code: 'malformed_request' });

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
		return json(201, commit(key, body));
	}

	const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		const headers = Object.fromEntries(new Headers(init?.headers).entries());
		const method = init?.method ?? 'GET';
		const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
		if (url.origin !== TEST_BASE_URL) throw new TypeError(`unexpected host ${url.origin}`);
		if (method === 'POST' && url.pathname === '/auth/service/token') return issueToken(body);

		calls.push({ method, path: url.pathname, headers, body, cache: init?.cache });
		const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1];
		if (!bearer || !live.has(bearer)) {
			return json(401, { code: 'unauthenticated', message: 'Authentication is required' });
		}
		const permission = PERMISSIONS[`${method} ${url.pathname}`];
		if (permission && !granted.has(permission)) {
			return json(403, {
				code: 'forbidden',
				message: 'The authenticated principal is not permitted to perform this request'
			});
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
		exchanges,
		committed,
		/** The access tokens issued so far, oldest first. */
		tokens: () => [...issued],
		/** Every issued token stops working (expired, or the backend's signing key rotated). */
		expireTokens: () => live.clear(),
		/** Removes a permission from the service's role, as an administrator could at any time. */
		revoke: (permission: string) => granted.delete(permission),
		/** Lifetime (`expiresIn`) of tokens issued from now on. */
		setTokenLifetime: (seconds: number) => (tokenLifetimeSeconds = seconds),
		/** Queue one-off answers for the next POST /inquiries calls. */
		script: (...next: Scripted[]) => scripted.push(...next),
		posts: () => calls.filter((c) => c.method === 'POST' && c.path === '/inquiries')
	};
}

export type FakeCommerce = ReturnType<typeof fakeCommerce>;
