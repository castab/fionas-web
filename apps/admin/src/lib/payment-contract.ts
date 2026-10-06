/** Transport from fionas-commerce's current OpenAPI payment schemas. */
import type { DocumentReconciliation } from './request-contract.js';

export type PaymentExternalReference = { provider: string; reference: string };
export type RecordPaymentRequest = {
	documentVersion: number;
	amount: string;
	method: string;
	receivedAt?: string | null;
	externalReference?: PaymentExternalReference | null;
	expectedProposalId?: string | null;
};
export type PaymentRecordResponse = {
	paymentId: string;
	method: string;
	amount: string;
	currency: string;
	receivedAt: string;
	externalReference?: PaymentExternalReference | null;
};
export type PaymentAllocationRecordResponse = {
	allocationId: string;
	paymentId: string;
	documentId: string;
	documentVersion: number;
	amount: string;
	currency: string;
	allocatedAt: string;
};
export type RefundRecordResponse = {
	refundId: string;
	paymentId: string;
	amount: string;
	currency: string;
	method: string;
	refundedAt: string;
	externalReference?: PaymentExternalReference | null;
};
export type RefundAllocationRecordResponse = {
	refundAllocationId: string;
	refundId: string;
	paymentAllocationId: string;
	amount: string;
	currency: string;
	allocatedAt: string;
};
export type PaymentReconciliationResponse = {
	paymentAmount: string;
	totalRefunded: string;
	netReceived: string;
	grossAllocated: string;
	allocationReversals: string;
	refundAllocations: string;
	netAllocated: string;
	unallocated: string;
	currency: string;
};
export type PaymentHistoryResponse = {
	payment: PaymentRecordResponse;
	allocations: PaymentAllocationRecordResponse[];
	refunds: RefundRecordResponse[];
	refundAllocations: RefundAllocationRecordResponse[];
	reconciliation: PaymentReconciliationResponse;
};
export type RecordedPaymentResponse = PaymentRecordResponse & {
	allocationId: string;
	documentId: string;
	documentVersion: number;
	allocatedAt: string;
	reconciliation: DocumentReconciliation;
};
