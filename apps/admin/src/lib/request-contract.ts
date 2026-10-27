import type { StaffDashboardItem } from './dashboard-contract.js';
import type { PaymentHistoryResponse } from './payment-contract.js';
import type { QuoteCommand, ServicePlanItem, ServicePlanResponse } from './quote-contract.js';

/** Transport shapes from the supplied fionas-commerce OpenAPI staff-request schemas. */
/**
 * A customer's original pick, recorded with the inquiry. It shares the approved selection's shape
 * (commerce returns absent metadata as null) but is historical intent, never an approved commitment.
 */
export type RequestedItem = ServicePlanItem;
export type RequestedService = {
	guestCount: number;
	guestCountIsMinimum: boolean;
	items: RequestedItem[];
	pricingReference?: string;
};
export type InquiryMilestone = {
	occurredAt: string;
	principalKind: 'USER' | 'SERVICE';
	principalId: string;
};
/**
 * Every lifecycle stage the backend projects. DECLINED is a terminal alternative to QUOTED (only
 * REQUESTED → DECLINED exists), not a step after CLOSED.
 */
export type InquiryStage = 'REQUESTED' | 'QUOTED' | 'BOOKED' | 'SERVED' | 'CLOSED' | 'DECLINED';
/** The recorded terminal decline (`InquiryDeclineResponse`): an internal staff decision. */
export type InquiryDecline = {
	occurredAt: string;
	/** Always USER: only a verified staff user declines. */
	principalKind: 'USER';
	principalId: string;
	/** Trimmed internal reason, at most 500 characters; never sent to the customer. */
	reason: string;
	/** The exact canonical Estimate version that was reviewed and declined. */
	documentVersion: number;
};
export type InquiryLifecycle = {
	documentId: string;
	stage: InquiryStage;
	served?: InquiryMilestone | null;
	closed?: InquiryMilestone | null;
	/** Present exactly when stage is DECLINED; absent or null otherwise. */
	declined?: InquiryDecline | null;
};
/** `POST /inquiries/{inquiryId}/decline`; actor and time come only from authentication. */
export type DeclineInquiryRequest = {
	expectedDocumentVersion: number;
	reason: string;
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
/**
 * Who recorded a document's lines. A PRINCIPAL is a staff USER or a SERVICE credential. INTERNAL is a
 * commerce component (such as inquiry intake pricing the first Estimate) with no principal at all.
 * `originKind` is absent from commerce versions that predate internal origins: those are PRINCIPAL.
 */
export type LineAuthorship = {
	originKind?: 'PRINCIPAL' | 'INTERNAL';
	principalKind?: 'USER' | 'SERVICE' | null;
	principalId?: string | null;
	component?: string | null;
	recordedAt: string;
};
export type FinancialDocumentResponse = {
	id: string;
	version: number;
	createdAt: string;
	previousVersion?: number;
	/** OpenAPI describes the known stages but leaves this transport property a string. */
	stage: string;
	inquiryId: string;
	linesAuthoredBy: LineAuthorship;
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
