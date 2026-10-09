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
export type ServicePlanRequest = {
	description: string;
	guestCount?: number;
	items?: string[];
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
	items: string[];
	lineNotes: { lineItemId: string; note: string }[];
};
export type ServicePlanResponse = ServicePlanPreview & {
	documentId: string;
	documentVersion: number;
	reviewedDocumentVersion: number;
	approvedAt: string;
	approvedBy: string;
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
