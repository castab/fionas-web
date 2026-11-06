import { isFinancialEmailPreview, isFinancialEmailSendResponse } from '../financial-email.js';
import type {
	FinancialEmailIntent,
	FinancialEmailPreview,
	FinancialEmailSendRequest,
	FinancialEmailSendResponse
} from '../financial-email-contract.js';
import { request, type ApiResult, type BackendConfig } from './backend.js';

const path = (inquiryId: string, suffix: string) =>
	`/staff/requests/${encodeURIComponent(inquiryId)}/financial-emails${suffix}`;

/**
 * `POST …/financial-emails/preview`: write-free review. The body is the reviewed identity and
 * optional message only; a response that does not answer exactly that identity is unavailable.
 */
export async function previewFinancialEmail(
	config: BackendConfig,
	inquiryId: string,
	email: FinancialEmailIntent,
	cookie: string | null
): Promise<ApiResult<FinancialEmailPreview>> {
	const result = await request<unknown>(config, path(inquiryId, '/preview'), {
		method: 'POST',
		json: email,
		cookie,
		capability: 'financialEmailPreview'
	});
	if (!result.ok) return result;
	if (isFinancialEmailPreview(result.data, email, inquiryId))
		return { ...result, data: result.data };
	console.error('[financial-email] invalid preview response');
	return {
		ok: false,
		retryAfter: null,
		error: { status: 503, code: 'invalid_preview', message: 'Preview unavailable', violations: [] }
	};
}

/**
 * `POST …/financial-emails` with the command's own Idempotency-Key. Exactly one attempt: the caller
 * decides, with staff, whether to reconcile. A success that is not a validated 201/200 ACCEPTED or
 * 202 UNKNOWN is ambiguous (`uncertain_send`), never a refusal.
 */
export async function sendFinancialEmail(
	config: BackendConfig,
	inquiryId: string,
	key: string,
	body: FinancialEmailSendRequest,
	cookie: string | null
): Promise<ApiResult<FinancialEmailSendResponse>> {
	const result = await request<unknown>(config, path(inquiryId, ''), {
		method: 'POST',
		json: body,
		cookie,
		idempotencyKey: key,
		capability: 'financialEmailSend'
	});
	if (!result.ok) return result;
	if (isFinancialEmailSendResponse(result.data, result.status))
		return { ...result, data: result.data };
	return {
		ok: false,
		retryAfter: null,
		error: {
			status: 503,
			code: 'uncertain_send',
			message: 'Send status not yet confirmed',
			violations: []
		}
	};
}
