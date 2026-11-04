import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { request, type BackendConfig } from './backend.js';
import { applySetCookies } from './auth.js';
import { backendConfig } from './config.js';
import {
	customerPaymentsErrorMessage,
	customerPaymentsStage,
	hasPaymentAccessPermissions,
	readLinkStatus,
	readPaymentAttempts,
	readPaymentLinkUrl,
	readReconcileResult,
	type CustomerPaymentsResult,
	type CustomerPaymentsView,
	type PaymentLinkIntent
} from '../customer-payments.js';
import type { InquiryStage } from '../request-contract.js';

/**
 * Staff customer-payment access through the admin BFF: the staff member's own session cookie and
 * trusted Origin via `request()`, never a SERVICE token. POSTs have no body. Each mutation is sent
 * once and never retried; an ambiguous outcome asks for a reload.
 */
const base = (inquiryId: string) => `/staff/requests/${encodeURIComponent(inquiryId)}`;

export function getPaymentAccess(config: BackendConfig, inquiryId: string, cookie: string | null) {
	return request<unknown>(config, `${base(inquiryId)}/payment-access`, { cookie });
}

export function managePaymentAccess(
	config: BackendConfig,
	inquiryId: string,
	action: 'issue' | 'rotate' | 'revoke',
	cookie: string | null
) {
	const suffix = action === 'issue' ? '' : `/${action}`;
	return request<unknown>(config, `${base(inquiryId)}/payment-access${suffix}`, {
		method: 'POST',
		cookie
	});
}

export function listPaymentAttempts(
	config: BackendConfig,
	inquiryId: string,
	cookie: string | null
) {
	return request<unknown>(config, `${base(inquiryId)}/payment-attempts`, { cookie });
}

export function reconcilePaymentAttempt(
	config: BackendConfig,
	inquiryId: string,
	attemptId: string,
	cookie: string | null
) {
	return request<unknown>(
		config,
		`${base(inquiryId)}/payment-attempts/${encodeURIComponent(attemptId)}/reconcile`,
		{ method: 'POST', cookie }
	);
}

/**
 * The workspace's minimal customer-payments read: link status (no URL) and attempt diagnostics.
 * Null when this staff member lacks the permissions or the stage can't have a link, so a missing
 * grant never costs a backend call or breaks the workspace.
 */
export async function loadCustomerPayments(
	config: BackendConfig,
	inquiryId: string,
	cookie: string | null,
	/** Null for a refresh of an already-rendered section (the page checked the stage). */
	stage: InquiryStage | null,
	permissions: string[]
): Promise<CustomerPaymentsView | null> {
	if (!hasPaymentAccessPermissions(permissions) || (stage && !customerPaymentsStage(stage)))
		return null;
	const [access, attempts] = await Promise.all([
		getPaymentAccess(config, inquiryId, cookie),
		listPaymentAttempts(config, inquiryId, cookie)
	]);
	if (!access.ok) {
		if (access.error.status === 503 && access.error.code === 'stripe_disabled')
			return { availability: 'disabled' };
		if (access.error.status === 401 || access.error.status === 403)
			return { availability: 'forbidden' };
		console.error(
			`[customer-payments] ${inquiryId} payment-access ${access.error.status} ${access.error.code}`
		);
		return { availability: 'unavailable' };
	}
	const link = readLinkStatus(access.data);
	if (!link) return { availability: 'unavailable' };
	// Optional diagnostics: a failed read leaves link management usable.
	return {
		availability: 'ready',
		link,
		attempts: attempts.ok ? readPaymentAttempts(attempts.data) : null
	};
}

const INTENTS: PaymentLinkIntent[] = ['issue', 'reveal', 'rotate', 'revoke', 'reconcile'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ActionForm = { intent: PaymentLinkIntent; attemptId?: string };

/** Exactly `intent`, plus `confirm` (rotate/revoke, equal to the intent) or `attemptId` (reconcile). */
function readActionForm(form: FormData): ActionForm | null {
	const keys = [...form.keys()];
	const one = (name: string) => {
		const values = form.getAll(name);
		return values.length === 1 && typeof values[0] === 'string' ? values[0] : null;
	};
	const intent = one('intent') as PaymentLinkIntent | null;
	if (!intent || !INTENTS.includes(intent)) return null;
	const expected =
		intent === 'rotate' || intent === 'revoke'
			? ['intent', 'confirm']
			: intent === 'reconcile'
				? ['intent', 'attemptId']
				: ['intent'];
	if (keys.length !== expected.length || !expected.every((name) => keys.includes(name)))
		return null;
	if ((intent === 'rotate' || intent === 'revoke') && one('confirm') !== intent) return null;
	if (intent === 'reconcile') {
		const attemptId = one('attemptId');
		return attemptId && UUID.test(attemptId) ? { intent, attemptId } : null;
	}
	return { intent };
}

/**
 * `?/customerPayments`: one deliberate staff command. With JavaScript the component consumes the
 * result locally (no workspace invalidation); natively the page re-renders with it. The usable URL
 * appears only in a `reveal` result, never in load data.
 */
export async function customerPaymentsAction({
	locals,
	params,
	request: incoming,
	url,
	cookies
}: RequestEvent) {
	if (!locals.user) redirect(303, '/login');
	const inquiryId = params.inquiryId ?? '';
	let form: FormData;
	try {
		form = await incoming.formData();
	} catch {
		return fail(400, {
			customerPayments: { intent: 'reveal', error: 'That request was refused.' }
		});
	}
	const values = readActionForm(form);
	if (!values)
		return fail(400, {
			customerPayments: {
				intent: 'reveal',
				error: 'That request was refused. Reload and try again.'
			} satisfies CustomerPaymentsResult
		});
	const { intent } = values;
	const failure = (status: number, code?: string, reviewRequired = false) =>
		fail(status >= 500 ? 503 : status, {
			customerPayments: {
				intent,
				error: customerPaymentsErrorMessage(intent, status, code),
				reviewRequired
			} satisfies CustomerPaymentsResult
		});
	if (!hasPaymentAccessPermissions(locals.user.permissions)) return failure(403);
	const config = backendConfig(url.origin);
	const cookie = incoming.headers.get('cookie');
	const mutation = intent !== 'reveal';
	const result =
		intent === 'reveal'
			? await getPaymentAccess(config, inquiryId, cookie)
			: intent === 'reconcile'
				? await reconcilePaymentAttempt(config, inquiryId, values.attemptId!, cookie)
				: await managePaymentAccess(config, inquiryId, intent, cookie);
	if (!result.ok) {
		if (result.error.status === 401) redirect(303, '/login');
		const definite =
			[400, 403, 404, 409, 422].includes(result.error.status) ||
			result.error.code === 'stripe_disabled';
		// Never retried. A 5xx or lost response after a mutation may have committed.
		return failure(result.error.status, result.error.code, mutation && !definite);
	}
	applySetCookies(cookies, result.setCookies);
	if (intent === 'reconcile') {
		const reconciled = readReconcileResult(result.data);
		const attempts = await listPaymentAttempts(config, inquiryId, cookie);
		return {
			customerPayments: {
				intent,
				reconciled: reconciled ?? undefined,
				attempts: attempts.ok ? readPaymentAttempts(attempts.data) : null,
				message: reconciled
					? 'Checked with Stripe. The attempt list below shows the current result.'
					: 'Checked with Stripe. Reload to review the current result.'
			} satisfies CustomerPaymentsResult
		};
	}
	const link = readLinkStatus(result.data);
	if (!link) return failure(503, undefined, mutation);
	if (intent === 'reveal') {
		const linkUrl = readPaymentLinkUrl(result.data);
		if (!linkUrl) return { customerPayments: { intent, link } satisfies CustomerPaymentsResult };
		return { customerPayments: { intent, link, url: linkUrl } satisfies CustomerPaymentsResult };
	}
	return {
		customerPayments: {
			intent,
			link,
			message:
				intent === 'issue'
					? 'Payment link ready. Copy it to share with the customer.'
					: intent === 'rotate'
						? 'Payment link rotated. The previous link no longer works; copy the new one to share.'
						: 'Payment link revoked. The customer can no longer open it.'
		} satisfies CustomerPaymentsResult
	};
}
