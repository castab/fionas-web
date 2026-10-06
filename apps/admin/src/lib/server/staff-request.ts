import type {
	StaffRequestResponse,
	DepositTermsRequest,
	IssueInquiryProposalRequest,
	IssuedInquiryProposalResponse
} from '../request-contract.js';
import { request, type BackendConfig } from './backend.js';
import type { RecordPaymentRequest, RecordedPaymentResponse } from '../payment-contract.js';

export function recordPayment(
	config: BackendConfig,
	documentId: string,
	json: RecordPaymentRequest,
	cookie: string | null
) {
	return request<RecordedPaymentResponse>(
		config,
		`/financial-documents/${encodeURIComponent(documentId)}/payments`,
		{ method: 'POST', json, cookie }
	);
}

export function getStaffRequest(config: BackendConfig, inquiryId: string, cookie: string | null) {
	return request<StaffRequestResponse>(config, `/staff/requests/${encodeURIComponent(inquiryId)}`, {
		cookie
	});
}

export function issueInquiryProposal(
	config: BackendConfig,
	inquiryId: string,
	expectedDocumentVersion: number,
	terms: DepositTermsRequest,
	cookie: string | null
) {
	const json: IssueInquiryProposalRequest = { expectedDocumentVersion, terms };
	return request<IssuedInquiryProposalResponse>(
		config,
		`/staff/requests/${encodeURIComponent(inquiryId)}/proposals`,
		{
			method: 'POST',
			json,
			cookie
		}
	);
}
