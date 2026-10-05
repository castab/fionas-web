import type { StaffDashboardItem } from './dashboard-contract.js';

/** Transport shapes from the supplied fionas-commerce OpenAPI staff-request schemas. */
export type PricingSelection = { category: string; offerings: string[] };
export type InquiryRequestedPricing = {
	catalogRevision: number;
	guestCount: number;
	guestCountIsMinimum: boolean;
	durationMinutes: number;
	selections: PricingSelection[];
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
	pricingInputs: InquiryRequestedPricing;
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
	pricing?: InquiryRequestedPricing;
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
};
export type StageTransitionRequest = { expectedVersion: number };
export type CurrentStaffRequest = StaffRequestResponse & {
	financial: FinancialDocumentResponse & { reconciliation: DocumentReconciliation };
};
