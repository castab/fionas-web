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
	QuoteCompositionRequest
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
	reviewed?: { composition: QuoteCompositionRequest; reviewToken: string }
) {
	const json: IssueInquiryProposalRequest = { expectedDocumentVersion, terms };
	if (reviewed) {
		json.composition = reviewed.composition;
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

/** Current catalog names, limits and availability for the quote builder's selection editor. */
export function getOfferingCatalog(config: BackendConfig, cookie: string | null) {
	return request<unknown>(config, '/offering-catalog', { cookie });
}

/** Service durations and the guest minimum, which the catalog itself does not carry. */
export function getInquiryForm(config: BackendConfig, cookie: string | null) {
	return request<unknown>(config, '/inquiry-form', { cookie });
}
