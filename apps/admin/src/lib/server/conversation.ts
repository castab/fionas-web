import { isStaffTimeline } from '../conversation.js';
import type {
	StaffReplyRequest,
	StaffReplyResponse,
	StaffTimeline
} from '../conversation-contract.js';
import { request, type ApiResult, type BackendConfig } from './backend.js';

export async function getStaffTimeline(
	config: BackendConfig,
	inquiryId: string,
	cookie: string | null
): Promise<ApiResult<StaffTimeline>> {
	const result = await request<unknown>(
		config,
		`/staff/requests/${encodeURIComponent(inquiryId)}/timeline`,
		{ cookie }
	);
	if (!result.ok) return result;
	if (isStaffTimeline(result.data, inquiryId)) return { ...result, data: result.data };
	console.error('[conversation] invalid timeline response');
	return {
		ok: false,
		retryAfter: null,
		error: {
			status: 503,
			code: 'invalid_timeline',
			message: 'Conversation unavailable',
			violations: []
		}
	};
}
export function acknowledgeInquiryCommunication(
	config: BackendConfig,
	inquiryId: string,
	throughRecordedOrder: number,
	cookie: string | null
) {
	return request<null>(
		config,
		`/inquiries/${encodeURIComponent(inquiryId)}/communications/acknowledge`,
		{ method: 'POST', json: { throughRecordedOrder }, cookie }
	);
}
/** One attempt, including UNKNOWN. Only the staff member initiates identical reconciliation. */
export async function sendStaffConversationReply(
	config: BackendConfig,
	inquiryId: string,
	key: string,
	body: StaffReplyRequest,
	cookie: string | null
) {
	const result = await request<StaffReplyResponse>(
		config,
		`/staff/requests/${encodeURIComponent(inquiryId)}/conversation/replies`,
		{ method: 'POST', json: body, cookie, idempotencyKey: key, conversationReply: true }
	);
	if (!result.ok) return result;
	const r = result.data;
	if (
		r &&
		typeof r.replayed === 'boolean' &&
		((result.status === 202 && r.outcome === 'UNKNOWN') ||
			((result.status === 200 || result.status === 201) &&
				r.outcome === 'ACCEPTED' &&
				typeof r.messageId === 'string' &&
				typeof r.conversationId === 'string' &&
				(r.sendState === 'pending' || r.sendState === 'accepted')))
	)
		return result;
	return {
		ok: false as const,
		retryAfter: null,
		error: {
			status: 503,
			code: 'uncertain_send',
			message: 'Send status not yet confirmed',
			violations: []
		}
	};
}
