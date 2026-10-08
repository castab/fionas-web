import type {
	DepositMoneyResponse,
	DepositTermsRequest,
	PricingSelection
} from './request-contract.js';

/** Transport shapes from the supplied fionas-commerce OpenAPI quote-builder schemas. */
export type QuotePricingBasis =
	'KEEP_ESTIMATE' | 'REVISE_SERVICE_SELECTIONS' | 'REPRICE_CONFIGURATION';
export type QuotePricingRequest =
	| { mode: 'KEEP_ESTIMATE' }
	| { mode: 'REVISE_SERVICE_SELECTIONS'; catalogRevision: number; selections: PricingSelection[] }
	| {
			mode: 'REPRICE_CONFIGURATION';
			catalogRevision: number;
			guestCount: number;
			guestCountIsMinimum: boolean;
			durationMinutes: number;
			selections: PricingSelection[];
	  };
export type ChargeSource =
	| { type: 'BASE_SERVICE' }
	| { type: 'ICE_CREAM_SERVICE' }
	| { type: 'EXTRA_TOPPINGS' }
	| { type: 'SELECTED_OFFERING'; category: string; offering: string };
export type QuoteOverrideTarget = { type: 'EXISTING_LINE'; lineItemId: string } | ChargeSource;
export type QuoteOverrideRequest = {
	target: QuoteOverrideTarget;
	finalAmount: string;
	currency: string;
	reason: string;
};
export type AdjustmentKind = 'CHARGE' | 'DISCOUNT' | 'CREDIT';
export type QuoteAdjustmentRequest = {
	clientKey: string;
	kind: AdjustmentKind;
	description: string;
	subDescription?: string;
	amount: string;
	currency: string;
	reason: string;
};
export type QuoteCompositionRequest = {
	pricing: QuotePricingRequest;
	overrides?: QuoteOverrideRequest[];
	adjustments?: QuoteAdjustmentRequest[];
};
export type PreviewInquiryQuoteRequest = {
	expectedDocumentVersion: number;
	composition: QuoteCompositionRequest;
	terms: DepositTermsRequest;
};

export type QuoteLineOrigin =
	| { type: 'ESTIMATE_LINE' }
	| { type: 'GENERATED'; source: ChargeSource }
	| { type: 'ADJUSTMENT'; kind: AdjustmentKind; reason: string; clientKey?: string };
export type QuoteLineOverride = {
	reason: string;
	originalQuantity?: string;
	originalUnitPrice: string;
	originalTotal: string;
};
export type QuotePreviewLine = {
	lineItemId?: string;
	origin: QuoteLineOrigin;
	description: string;
	subDescription?: string;
	quantity?: string;
	unitPrice: string;
	subtotal: string;
	taxAmount: string;
	total: string;
	currency: string;
	override?: QuoteLineOverride;
};
export type ServicePlanOffering = { offering: string; displayName: string; description?: string };
export type ServicePlanCategory = {
	category: string;
	displayName: string;
	offerings: ServicePlanOffering[];
};
export type ServiceConfiguration = {
	guestCount: number;
	guestCountIsMinimum: boolean;
	durationMinutes: number;
	selections: ServicePlanCategory[];
};
export type InquiryQuotePreviewResponse = {
	inquiryId: string;
	documentId: string;
	reviewedDocumentVersion: number;
	estimateTotal: string;
	/** A string, not an enum, in the supplied schema. */
	pricingBasis: string;
	catalogRevision: number;
	financialChange: boolean;
	quoteVersion: number;
	service: ServiceConfiguration;
	lines: QuotePreviewLine[];
	subtotal: string;
	taxAmount: string;
	total: string;
	currency: string;
	deposit: { terms: DepositTermsRequest; requiredAmount: DepositMoneyResponse };
	reviewToken: string;
};
export type ServicePlanLine = {
	lineItemId: string;
	origin: QuoteLineOrigin;
	overrideReason?: string;
};
export type ServicePlanResponse = {
	documentId: string;
	documentVersion: number;
	reviewedDocumentVersion: number;
	pricingBasis: string;
	catalogRevision: number;
	approvedAt: string;
	principalKind: string;
	principalId: string;
	service: ServiceConfiguration;
	lines: ServicePlanLine[];
};
