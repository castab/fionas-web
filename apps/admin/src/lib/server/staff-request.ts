import type {
	InquiryLifecycle,
	StaffRequestResponse,
	DepositTermsRequest,
	IssueInquiryProposalRequest,
	IssuedInquiryProposalResponse
} from '../request-contract.js';
import type {
	InquiryQuotePreviewResponse,
	PreviewInquiryQuoteRequest,
	QuoteCommand
} from '../quote-contract.js';
import { request, type BackendConfig } from './backend.js';
import type { RecordPaymentRequest, RecordedPaymentResponse } from '../payment-contract.js';

export function markInquiryServed(config: BackendConfig, inquiryId: string, cookie: string | null) {
	return request<InquiryLifecycle>(config, `/inquiries/${encodeURIComponent(inquiryId)}/served`, {
		method: 'POST',
		cookie
	});
}

export function closeInquiry(config: BackendConfig, inquiryId: string, cookie: string | null) {
	return request<InquiryLifecycle>(config, `/inquiries/${encodeURIComponent(inquiryId)}/close`, {
		method: 'POST',
		cookie
	});
}

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
	cookie: string | null,
	reviewed?: QuoteCommand & { reviewToken: string }
) {
	const json: IssueInquiryProposalRequest = { expectedDocumentVersion, terms };
	if (reviewed) {
		json.lines = reviewed.lines;
		json.servicePlan = reviewed.servicePlan;
		json.reviewToken = reviewed.reviewToken;
	}
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

/** A query that writes nothing, even on failure; safe to repeat after any outcome. */
export function previewInquiryQuote(
	config: BackendConfig,
	inquiryId: string,
	json: PreviewInquiryQuoteRequest,
	cookie: string | null
) {
	return request<InquiryQuotePreviewResponse>(
		config,
		`/staff/requests/${encodeURIComponent(inquiryId)}/quote-preview`,
		{ method: 'POST', json, cookie }
	);
}
