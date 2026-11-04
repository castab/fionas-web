import { beforeEach, describe, expect, it, vi } from 'vitest';
import { customerPaymentsAction, loadCustomerPayments } from './customer-payments.js';
import {
	PAYMENT_ACCESS_PERMISSIONS,
	canIssuePaymentLink,
	customerPaymentsStage,
	readLinkStatus,
	readPaymentAttempts,
	readPaymentLinkUrl
} from '$lib/customer-payments.js';
import type { BackendConfig } from './backend.js';

const inquiryId = '00000000-0000-0000-0000-000000000007';
const publicId = 'b8251ea0-c07c-4aad-bceb-644ed075c0a1';
const secret = 'S'.repeat(43);
const linkUrl = `https://www.fionasicecream.com/pay/${publicId}#${secret}`;
const attempt = {
	id: '8cf42464-739b-43ca-b684-d0f802245c55',
	purpose: 'INVOICE',
	authorizedMinor: 10000,
	documentVersion: 6,
	businessRevision: 8,
	state: 'SUCCEEDED',
	outcome: 'RECONCILIATION_REQUIRED',
	createdAt: '2027-03-01T18:00:00Z',
	expiresAt: '2027-03-01T19:00:00Z',
	sessionId: 'cs_test_1',
	paymentIntentId: 'pi_test_1',
	ledgerPaymentId: '40000000-0000-0000-0000-000000000009',
	diagnostic: 'invoice_balance_changed'
};

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[] = [];
let routes: Record<string, () => Response> = {};
const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
	const path = new URL(url).pathname;
	calls.push({
		url: path,
		method: init.method ?? 'GET',
		headers: Object.fromEntries(new Headers(init.headers).entries()),
		body: init.body
	});
	const route = routes[`${init.method ?? 'GET'} ${path}`];
	return route ? route() : Response.json({ code: 'not_found', message: 'x' }, { status: 404 });
}) as unknown as typeof fetch;

vi.mock('./config.js', () => ({
	backendConfig: (): BackendConfig => ({
		baseUrl: 'http://api.test',
		origin: 'http://admin.test',
		fetch: fakeFetch
	})
}));

const config: BackendConfig = {
	baseUrl: 'http://api.test',
	origin: 'http://admin.test',
	fetch: fakeFetch
};
const base = `/staff/requests/${inquiryId}`;
const permitted = [...PAYMENT_ACCESS_PERMISSIONS, 'commerce.payment.record'];

beforeEach(() => {
	calls = [];
	routes = {
		[`GET ${base}/payment-access`]: () => Response.json({ publicId, revoked: false, url: linkUrl }),
		[`POST ${base}/payment-access`]: () =>
			Response.json({ publicId, revoked: false, url: linkUrl }),
		[`POST ${base}/payment-access/rotate`]: () =>
			Response.json({ publicId, revoked: false, url: linkUrl.replace(secret, 'R'.repeat(43)) }),
		[`POST ${base}/payment-access/revoke`]: () => Response.json({ publicId, revoked: true }),
		[`GET ${base}/payment-attempts`]: () => Response.json({ items: [attempt] }),
		[`POST ${base}/payment-attempts/${attempt.id}/reconcile`]: () =>
			Response.json({
				attemptId: attempt.id,
				url: 'https://checkout.stripe.com/c/pay/x',
				state: 'SUCCEEDED',
				outcome: 'RECONCILIATION_REQUIRED'
			})
	};
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

function actionEvent(entries: [string, string][], permissions = permitted) {
	const form = new FormData();
	for (const [key, value] of entries) form.append(key, value);
	return {
		params: { inquiryId },
		url: new URL(`http://admin.test/requests/${inquiryId}?/customerPayments`),
		request: new Request('http://admin.test', {
			method: 'POST',
			headers: { cookie: '__Host-fionas_session="staff"' },
			body: form
		}),
		locals: { user: { id: 'staff', roles: [], permissions } },
		cookies: { set: vi.fn() }
	} as unknown as Parameters<typeof customerPaymentsAction>[0];
}

const data = (result: unknown) =>
	(result as { customerPayments?: Record<string, unknown> }).customerPayments ??
	(result as { data: { customerPayments: Record<string, unknown> } }).data.customerPayments;

describe('contract helpers', () => {
	it('reads link status without the URL', () => {
		expect(readLinkStatus({ revoked: false })).toEqual({ state: 'none' });
		expect(readLinkStatus({ publicId, revoked: false, url: linkUrl })).toEqual({
			state: 'active',
			publicId
		});
		expect(readLinkStatus({ publicId, revoked: true })).toEqual({ state: 'revoked', publicId });
		expect(readLinkStatus({ publicId: 'nope', revoked: false })).toBeNull();
	});

	it('accepts only a well-formed /pay/{publicId}#secret URL for copying', () => {
		expect(readPaymentLinkUrl({ publicId, revoked: false, url: linkUrl })).toBe(linkUrl);
		for (const url of [
			`https://www.fionasicecream.com/pay/${publicId}?token=${secret}`,
			`https://www.fionasicecream.com/pay/other#${secret}`,
			`javascript:alert(1)//pay/${publicId}#${secret}`,
			`https://www.fionasicecream.com/pay/${publicId}#short`
		])
			expect(readPaymentLinkUrl({ publicId, revoked: false, url })).toBeNull();
		expect(readPaymentLinkUrl({ publicId, revoked: true, url: linkUrl })).toBeNull();
	});

	it('validates attempt diagnostics', () => {
		expect(readPaymentAttempts({ items: [attempt] })).toHaveLength(1);
		expect(readPaymentAttempts({ items: [{ ...attempt, authorizedMinor: '100' }] })).toBeNull();
	});

	it('limits stages', () => {
		expect(['REQUESTED', 'DECLINED'].some((s) => customerPaymentsStage(s as never))).toBe(false);
		expect(canIssuePaymentLink('CLOSED')).toBe(false);
		expect(customerPaymentsStage('CLOSED')).toBe(true);
	});
});

describe('workspace read', () => {
	it('makes no backend call without all three permissions or for REQUESTED/DECLINED', async () => {
		for (const permission of PAYMENT_ACCESS_PERMISSIONS)
			expect(
				await loadCustomerPayments(
					config,
					inquiryId,
					'c',
					'BOOKED',
					PAYMENT_ACCESS_PERMISSIONS.filter((p) => p !== permission)
				)
			).toBeNull();
		expect(await loadCustomerPayments(config, inquiryId, 'c', 'REQUESTED', permitted)).toBeNull();
		expect(await loadCustomerPayments(config, inquiryId, 'c', 'DECLINED', permitted)).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it('exposes link status and attempts, never the usable URL', async () => {
		const view = await loadCustomerPayments(
			config,
			inquiryId,
			'session=staff',
			'BOOKED',
			permitted
		);
		expect(view).toMatchObject({
			availability: 'ready',
			link: { state: 'active', publicId },
			attempts: [{ id: attempt.id }]
		});
		expect(JSON.stringify(view)).not.toContain(secret);
		expect(calls.every((c) => c.headers.cookie === 'session=staff')).toBe(true);
		expect(calls.every((c) => c.headers.origin === 'http://admin.test')).toBe(true);
		expect(calls.some((c) => 'authorization' in c.headers)).toBe(false);
	});

	it('keeps link management when the optional attempts read fails', async () => {
		routes[`GET ${base}/payment-attempts`] = () =>
			Response.json({ code: 'internal_failure', message: 'x' }, { status: 500 });
		expect(await loadCustomerPayments(config, inquiryId, 'c', 'BOOKED', permitted)).toMatchObject({
			availability: 'ready',
			attempts: null
		});
	});

	it('reads disabled Stripe and backend refusals without breaking the workspace', async () => {
		routes[`GET ${base}/payment-access`] = () =>
			Response.json({ code: 'stripe_disabled', message: 'x' }, { status: 503 });
		expect(await loadCustomerPayments(config, inquiryId, 'c', 'BOOKED', permitted)).toEqual({
			availability: 'disabled'
		});
		routes[`GET ${base}/payment-access`] = () =>
			Response.json({ code: 'forbidden', message: 'x' }, { status: 403 });
		expect(await loadCustomerPayments(config, inquiryId, 'c', 'BOOKED', permitted)).toEqual({
			availability: 'forbidden'
		});
	});
});

describe('customer payments action', () => {
	it('reveals the URL only on a deliberate GET, without mutating', async () => {
		const result = await customerPaymentsAction(actionEvent([['intent', 'reveal']]));
		expect(data(result)).toMatchObject({ intent: 'reveal', url: linkUrl });
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${base}/payment-access`]);
	});

	it('issues, rotates and revokes with bodyless POSTs and returns status only', async () => {
		const issued = data(await customerPaymentsAction(actionEvent([['intent', 'issue']])));
		expect(issued).toMatchObject({ link: { state: 'active' } });
		expect(issued.url).toBeUndefined();
		const rotated = data(
			await customerPaymentsAction(
				actionEvent([
					['intent', 'rotate'],
					['confirm', 'rotate']
				])
			)
		);
		expect(rotated.url).toBeUndefined();
		const revoked = data(
			await customerPaymentsAction(
				actionEvent([
					['intent', 'revoke'],
					['confirm', 'revoke']
				])
			)
		);
		expect(revoked).toMatchObject({ link: { state: 'revoked' } });
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`POST ${base}/payment-access`,
			`POST ${base}/payment-access/rotate`,
			`POST ${base}/payment-access/revoke`
		]);
		expect(calls.every((c) => c.body === undefined)).toBe(true);
	});

	it('requires explicit confirmation for rotation and revocation', async () => {
		for (const entries of [
			[['intent', 'rotate']],
			[
				['intent', 'rotate'],
				['confirm', 'revoke']
			],
			[
				['intent', 'revoke'],
				['confirm', 'yes']
			],
			[
				['intent', 'issue'],
				['url', 'https://evil.example']
			],
			[['intent', 'refund']]
		] as [string, string][][]) {
			const result = await customerPaymentsAction(actionEvent(entries));
			expect(result).toMatchObject({ status: 400 });
		}
		expect(calls).toHaveLength(0);
	});

	it('refuses without the permissions and never substitutes a service credential', async () => {
		const result = await customerPaymentsAction(
			actionEvent([['intent', 'issue']], ['fionas.inquiries.read'])
		);
		expect(result).toMatchObject({ status: 403 });
		expect(calls).toHaveLength(0);
	});

	it('reconciles an attempt, drops any provider URL and refreshes diagnostics', async () => {
		const result = data(
			await customerPaymentsAction(
				actionEvent([
					['intent', 'reconcile'],
					['attemptId', attempt.id]
				])
			)
		);
		expect(result).toMatchObject({
			reconciled: { attemptId: attempt.id, state: 'SUCCEEDED', outcome: 'RECONCILIATION_REQUIRED' },
			attempts: [{ id: attempt.id }]
		});
		expect(JSON.stringify(result)).not.toContain('checkout.stripe.com');
	});

	it('maps CLOSED issuance refusals and ambiguous failures to safe copy', async () => {
		routes[`POST ${base}/payment-access/rotate`] = () =>
			Response.json({ code: 'illegal_transition', message: 'PRIVATE' }, { status: 409 });
		const refused = await customerPaymentsAction(
			actionEvent([
				['intent', 'rotate'],
				['confirm', 'rotate']
			])
		);
		expect(refused).toMatchObject({ status: 409 });
		expect(JSON.stringify(refused)).not.toContain('PRIVATE');
		expect(data(refused).reviewRequired).toBe(false);
		routes[`POST ${base}/payment-access`] = () =>
			Response.json({ code: 'internal_failure', message: 'x' }, { status: 500 });
		const ambiguous = await customerPaymentsAction(actionEvent([['intent', 'issue']]));
		expect(ambiguous).toMatchObject({ status: 503 });
		expect(data(ambiguous).reviewRequired).toBe(true);
		// Exactly one attempt each; nothing is retried.
		expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
	});
});
