import type { PaymentHistoryResponse } from './payment-contract.js';

export function isDecimal(value: unknown): value is string {
	return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value);
}
/** Validate only receipt and allocation fields consumed by presentation, not the entire ledger model. */
export function isPaymentHistory(value: PaymentHistoryResponse): boolean {
	const payment = value?.payment;
	const reconciliation = value?.reconciliation;
	const currency = (value: unknown) => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
	return (
		!!payment &&
		typeof payment.paymentId === 'string' &&
		typeof payment.method === 'string' &&
		isDecimal(payment.amount) &&
		currency(payment.currency) &&
		typeof payment.receivedAt === 'string' &&
		/^\d{4}-\d\d-\d\dT/.test(payment.receivedAt) &&
		Number.isFinite(Date.parse(payment.receivedAt)) &&
		!!reconciliation &&
		isDecimal(reconciliation.totalRefunded) &&
		isDecimal(reconciliation.netReceived) &&
		currency(reconciliation.currency) &&
		reconciliation.currency === payment.currency &&
		Array.isArray(value.allocations) &&
		value.allocations.every(
			(allocation) =>
				!!allocation &&
				typeof allocation.allocationId === 'string' &&
				typeof allocation.documentId === 'string' &&
				Number.isInteger(allocation.documentVersion) &&
				allocation.documentVersion > 0 &&
				isDecimal(allocation.amount) &&
				currency(allocation.currency)
		)
	);
}
