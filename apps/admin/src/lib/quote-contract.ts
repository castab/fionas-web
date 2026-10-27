import type { DepositTermsRequest, DepositMoneyResponse } from './request-contract.js';
export type ProposedLine = {
	lineItemId?: string;
	key?: string;
	description: string;
	subDescription?: string;
	quantity?: string;
	unitPrice: string;
	taxAmount: string;
	currency: string;
};
export type LineNote = { lineItemId?: string; key?: string; note: string };
/**
 * One approved selection (commerce PR #28): a required label, a free-form descriptive category and an
 * opaque optional source key. None of them selects a price, product or catalog entry.
 */
export type ServicePlanItem = { label: string; group?: string | null; key?: string | null };
export type ServicePlanRequest = {
	description: string;
	guestCount?: number;
	/** Never edited here; carried unchanged when a replacement keeps a plan that already has one. */
	durationMinutes?: number;
	items?: ServicePlanItem[];
	lineNotes?: LineNote[];
};
export type QuoteCommand = { lines: ProposedLine[]; servicePlan?: ServicePlanRequest };
export type PreviewInquiryQuoteRequest = QuoteCommand & {
	expectedDocumentVersion: number;
	terms: DepositTermsRequest;
};
export type QuotePreviewLine = {
	id: string;
	key?: string;
	origin: 'CARRIED' | 'REPLACED' | 'NEW';
	description: string;
	subDescription?: string;
	quantity?: string;
	unitPrice: string;
	subtotal: string;
	taxAmount: string;
	total: string;
	currency: string;
};
export type ServicePlanPreview = {
	description: string;
	guestCount?: number;
	durationMinutes?: number;
	items: ServicePlanItem[];
	lineNotes: { lineItemId: string; note: string }[];
};
/**
 * What staff do with the current service commitment when they revise a Quote or amend an Invoice.
 * The backend never infers it from field presence: RETAIN and CLEAR omit `servicePlan`, REPLACE
 * supplies the complete proposed plan.
 */
export type ServicePlanAction = 'RETAIN' | 'REPLACE' | 'CLEAR';
/**
 * One staff approval of the service commitment, with its own revision sequence (independent of the
 * financial version). A clearing approval (`cleared`) keeps its document references and provenance but
 * has no description, guest count or duration, and empty items and notes. `documentVersion` can be
 * older than the latest financial version when the approval was retained.
 */
export type ServicePlanResponse = Omit<ServicePlanPreview, 'description'> & {
	description?: string;
	durationMinutes?: number;
	documentId: string;
	documentVersion: number;
	reviewedDocumentVersion: number;
	approvedAt: string;
	approvedBy: string;
	revision: number;
	/** The backend always sends it; an absent value reads as false. */
	cleared?: boolean;
};
export type InquiryQuotePreviewResponse = {
	inquiryId: string;
	documentId: string;
	reviewedDocumentVersion: number;
	estimateTotal: string;
	financialChange: boolean;
	quoteVersion: number;
	lines: QuotePreviewLine[];
	subtotal: string;
	taxAmount: string;
	total: string;
	currency: string;
	deposit: { terms: DepositTermsRequest; requiredAmount: DepositMoneyResponse };
	servicePlan?: ServicePlanPreview;
	reviewToken: string;
};

/** `POST /staff/requests/{id}/quote-revision-preview` (publication adds a top-level `reviewToken`). */
export type RevisionCommand = QuoteCommand & { servicePlanAction: ServicePlanAction };
export type QuoteRevisionPreviewRequest = RevisionCommand & {
	expectedDocumentVersion: number;
	expectedDepositRequirementRevision: number;
	terms: DepositTermsRequest;
};
export type QuoteRevisionRequest = QuoteRevisionPreviewRequest & { reviewToken: string };
export type QuoteRevisionPreviewResponse = {
	/** `quote.estimateTotal` is the reviewed *current* Quote total on this endpoint. */
	quote: InquiryQuotePreviewResponse;
	currentProposalId: string;
	reviewedDepositRequirementRevision: number;
	currentServicePlanRevision?: number | null;
	resultingServicePlanRevision?: number | null;
	servicePlanChange: boolean;
	depositChange: boolean;
};
/** `POST /staff/requests/{id}/invoice-revision-preview` (approval adds `reviewToken`). */
export type InvoiceRevisionPreviewRequest = RevisionCommand & { expectedDocumentVersion: number };
export type InvoiceRevisionRequest = InvoiceRevisionPreviewRequest & { reviewToken: string };
export type InvoiceSettlement = 'UNDERPAID' | 'SETTLED' | 'OVERPAID';
export type InvoiceRevisionPreviewResponse = {
	inquiryId: string;
	documentId: string;
	reviewedDocumentVersion: number;
	resultingDocumentVersion: number;
	currentTotal: string;
	total: string;
	subtotal: string;
	taxAmount: string;
	currency: string;
	lines: QuotePreviewLine[];
	financialChange: boolean;
	servicePlanChange: boolean;
	currentServicePlanRevision?: number | null;
	resultingServicePlanRevision?: number | null;
	servicePlan?: ServicePlanPreview | null;
	netApplied: string;
	balance: string;
	settlement: InvoiceSettlement;
	reviewToken: string;
};
