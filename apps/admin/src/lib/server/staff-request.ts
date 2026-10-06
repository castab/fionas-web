import type {
	StaffRequestResponse,
	DepositTermsRequest,
	IssueInquiryProposalRequest,
	IssuedInquiryProposalResponse
} from '../request-contract.js';
import { request, type BackendConfig } from './backend.js';

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
