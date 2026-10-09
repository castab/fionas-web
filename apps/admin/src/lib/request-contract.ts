import type { StaffDashboardItem } from './dashboard-contract.js';
import type { PaymentHistoryResponse } from './payment-contract.js';
import type { QuoteCommand, ServicePlanResponse } from './quote-contract.js';

/** Transport shapes from the supplied fionas-commerce OpenAPI staff-request schemas. */
export type RequestedService = {
	guestCount: number;
	guestCountIsMinimum: boolean;
	durationMinutes?: number;
	items: { label: string; group?: string; key?: string }[];
	pricingReference?: string;
};
export type InquiryMilestone = {
	occurredAt: string;
	principalKind: 'USER' | 'SERVICE';
	principalId: string;
};
export type InquiryLifecycle = {
	documentId: string;
	stage: 'REQUESTED' | 'QUOTED' | 'BOOKED' | 'SERVED' | 'CLOSED';
	served?: InquiryMilestone;
	closed?: InquiryMilestone;
};
export type InquiryResponse = {
	id: string;
	customerId: string;
	name: string;
	email: string;
	message?: string;
	createdAt: string;
	requestedService: RequestedService;
	zipCode: string;
	eventDate: string;
	eventType: StaffDashboardItem['eventType'];
	lifecycle: InquiryLifecycle;
};
export type FinancialDocumentLine = {
	id: string;
	description: string;
	subDescription?: string;
	quantity?: string;
	unitPrice: string;
	subtotal: string;
	taxAmount: string;
	total: string;
	currency: string;
};
export type DocumentReconciliation = {
	grossAllocated: string;
	netApplied: string;
	balance: string;
	currency: string;
};
export type FinancialDocumentResponse = {
	id: string;
	version: number;
	createdAt: string;
	previousVersion?: number;
	/** OpenAPI describes the known stages but leaves this transport property a string. */
	stage: string;
	inquiryId: string;
	linesAuthoredBy: { principalKind: 'USER' | 'SERVICE'; principalId: string; recordedAt: string };
	lines: FinancialDocumentLine[];
	subtotal: string;
	taxAmount: string;
	total: string;
	currency: string;
	/** Optional in the shared schema; required for the current staff-request projection. */
	reconciliation?: DocumentReconciliation;
};
export type StaffRequestResponse = {
	inquiry: InquiryResponse;
	financial: FinancialDocumentResponse;
	/** Absent before issuance; the API's example also uses null. */
	proposal?: InquiryProposalResponse | null;
	suggestedDepositTerms: DepositTermsRequest;
	depositRequirement: CurrentDepositRequirementResponse;
	payments: PaymentHistoryResponse[];
	/** The latest proposal's approved plan; absent before issuance or for deposit-only Quotes. */
	servicePlan?: ServicePlanResponse | null;
};
export type DepositTermsRequest =
	{ type: 'PERCENTAGE'; percentage: string } | { type: 'FIXED'; amount: string; currency: string };
export type DepositMoneyResponse = { amount: string; currency: string };
export type CurrentDepositRequirementResponse =
	| { state: 'NONE'; documentId: string }
	| {
			state: 'ACTIVE';
			documentId: string;
			revision: number;
			previousRevision?: number;
			createdAt: string;
			approvalDocumentVersion: number;
			terms: DepositTermsRequest;
			requiredAmount: DepositMoneyResponse;
			satisfied: boolean;
	  }
	| {
			state: 'WITHDRAWN';
			documentId: string;
			revision: number;
			previousRevision: number;
			createdAt: string;
	  };
export type InquiryProposalResponse = {
	id: string;
	inquiryId: string;
	documentId: string;
	documentVersion: number;
	depositRequirementRevision: number;
	issuedAt: string;
	issuedBy: string;
	issuanceKind: string;
};
export type IssueInquiryProposalRequest = {
	expectedDocumentVersion: number;
	terms: DepositTermsRequest;
	/** Both or neither: the composition exactly as previewed, with that preview's token. */
	lines?: QuoteCommand['lines'];
	servicePlan?: QuoteCommand['servicePlan'];
	reviewToken?: string;
};
export type IssuedInquiryProposalResponse = {
	proposal: InquiryProposalResponse;
	financial: FinancialDocumentResponse;
	depositRequirement: CurrentDepositRequirementResponse;
	servicePlan?: ServicePlanResponse;
};
export type CurrentStaffRequest = StaffRequestResponse & {
	financial: FinancialDocumentResponse & { reconciliation: DocumentReconciliation };
};
