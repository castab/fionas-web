import type {
	DeclineInquiryRequest,
	DepositRequirementHistoryResponse,
	FinancialDocumentHistoryResponse,
	InquiryLifecycle,
	StaffRequestResponse,
	DepositTermsRequest,
	IssueInquiryProposalRequest,
	IssuedInquiryProposalResponse
} from '../request-contract.js';
import type {
	InquiryQuotePreviewResponse,
	InvoiceRevisionPreviewRequest,
	InvoiceRevisionPreviewResponse,
	InvoiceRevisionRequest,
	PreviewInquiryQuoteRequest,
	QuoteCommand,
	QuoteRevisionPreviewRequest,
	QuoteRevisionPreviewResponse,
	QuoteRevisionRequest,
	ServicePlanResponse
} from '../quote-contract.js';
import type { FinancialDocumentResponse } from '../request-contract.js';
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

/** One attempt per call: `request()` never retries, and callers must not either. */
export function declineInquiry(
	config: BackendConfig,
	inquiryId: string,
	json: DeclineInquiryRequest,
	cookie: string | null
) {
	return request<InquiryLifecycle>(config, `/inquiries/${encodeURIComponent(inquiryId)}/decline`, {
		method: 'POST',
		json: { expectedDocumentVersion: json.expectedDocumentVersion, reason: json.reason },
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

const staffPath = (inquiryId: string, tail: string) =>
	`/staff/requests/${encodeURIComponent(inquiryId)}/${tail}`;

/** A query that writes nothing; reviewing a revision is safe to repeat after any outcome. */
export function previewInquiryQuoteRevision(
	config: BackendConfig,
	inquiryId: string,
	json: QuoteRevisionPreviewRequest,
	cookie: string | null
) {
	return request<QuoteRevisionPreviewResponse>(
		config,
		staffPath(inquiryId, 'quote-revision-preview'),
		{
			method: 'POST',
			json,
			cookie
		}
	);
}

/** One attempt: the identical reviewed body plus the preview's own top-level `reviewToken`. */
export function reviseInquiryQuote(
	config: BackendConfig,
	inquiryId: string,
	json: QuoteRevisionRequest,
	cookie: string | null
) {
	return request<IssuedInquiryProposalResponse>(
		config,
		staffPath(inquiryId, 'proposals/quote-revisions'),
		{ method: 'POST', json, cookie }
	);
}

export function previewInquiryInvoiceRevision(
	config: BackendConfig,
	inquiryId: string,
	json: InvoiceRevisionPreviewRequest,
	cookie: string | null
) {
	return request<InvoiceRevisionPreviewResponse>(
		config,
		staffPath(inquiryId, 'invoice-revision-preview'),
		{ method: 'POST', json, cookie }
	);
}

/** One attempt. A duplicate approval conflicts, so an uncertain outcome is reviewed, never replayed. */
export function reviseInquiryInvoice(
	config: BackendConfig,
	inquiryId: string,
	json: InvoiceRevisionRequest,
	cookie: string | null
) {
	return request<{ financial: FinancialDocumentResponse; servicePlan?: ServicePlanResponse }>(
		config,
		staffPath(inquiryId, 'invoice-revisions'),
		{ method: 'POST', json, cookie }
	);
}

/** Every immutable financial snapshot, oldest first. Optional detail: its failure never hides the booking. */
export function getFinancialDocumentHistory(
	config: BackendConfig,
	documentId: string,
	cookie: string | null
) {
	return request<FinancialDocumentHistoryResponse>(
		config,
		`/financial-documents/${encodeURIComponent(documentId)}/history`,
		{ cookie }
	);
}

export function getDepositRequirementHistory(
	config: BackendConfig,
	documentId: string,
	cookie: string | null
) {
	return request<DepositRequirementHistoryResponse>(
		config,
		`/financial-documents/${encodeURIComponent(documentId)}/deposit-requirement/history`,
		{ cookie }
	);
}
