import type { CurrentStaffRequest } from './request-contract.js';
import { isDecimal } from './payment-history.js';
import { isCurrentStaffRequest } from './request-workspace.js';
import { BUSINESS_TIME_ZONE } from './presentation.js';

export const PAYMENT_PERMISSION = 'commerce.payment.record';
export const manualPaymentMethods = ['CASH', 'CHECK', 'OTHER'] as const;
export type ManualPaymentMethod = (typeof manualPaymentMethods)[number];
export function hasPaymentPermission(permissions: string[]): boolean {
	return permissions.includes(PAYMENT_PERMISSION);
}
export function paymentMethodLabel(method: string): string {
	const labels: Record<string, string> = {
		CASH: 'Cash',
		CHECK: 'Check',
		OTHER: 'Other',
		CARD: 'Card',
		BANK_TRANSFER: 'Bank transfer',
		DIGITAL_WALLET: 'Digital wallet'
	};
	return Object.hasOwn(labels, method) ? labels[method] : 'Unknown payment method';
}
export function receivedTimeLabel(instant: string): string {
	return new Intl.DateTimeFormat('en-US', {
		dateStyle: 'medium',
		timeStyle: 'short',
		timeZone: BUSINESS_TIME_ZONE
	}).format(new Date(instant));
}
/** Exact minor units for validation/comparison only, never settlement or pricing. */
export function moneyMinorUnits(value: string, currency: string): bigint | null {
	if (!isDecimal(value) || !/^[A-Z]{3}$/.test(currency)) return null;
	const digits =
		new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions()
			.maximumFractionDigits ?? 2;
	const [whole, fraction = ''] = value.split('.');
	if (fraction.length > digits) return null;
	return BigInt(whole + fraction.padEnd(digits, '0'));
}
export function invoiceAmountValid(amount: string, balance: string, currency: string): boolean {
	const value = moneyMinorUnits(amount, currency);
	const maximum = moneyMinorUnits(balance, currency);
	return value !== null && maximum !== null && value > 0n && value <= maximum;
}
export function canRecordDeposit(data: CurrentStaffRequest, permissions: string[]): boolean {
	return (
		hasPaymentPermission(permissions) &&
		isCurrentStaffRequest(data, data.inquiry.id) &&
		data.inquiry.lifecycle.stage === 'QUOTED' &&
		data.financial.stage === 'QUOTE' &&
		data.depositRequirement.state === 'ACTIVE' &&
		!data.depositRequirement.satisfied &&
		invoiceAmountValid(
			data.depositRequirement.requiredAmount.amount,
			data.financial.reconciliation.balance,
			data.financial.currency
		)
	);
}
export function canRecordInvoicePayment(data: CurrentStaffRequest, permissions: string[]): boolean {
	return (
		hasPaymentPermission(permissions) &&
		isCurrentStaffRequest(data, data.inquiry.id) &&
		['BOOKED', 'SERVED'].includes(data.inquiry.lifecycle.stage) &&
		data.financial.stage === 'INVOICE' &&
		(moneyMinorUnits(data.financial.reconciliation.balance, data.financial.currency) ?? 0n) > 0n
	);
}
export type PaymentFormValues = {
	expectedVersion: string;
	method: ManualPaymentMethod;
	expectedProposalId?: string;
	amount?: string;
};
export function readPaymentForm(form: FormData, deposit: boolean): PaymentFormValues | null {
	const fields = ['expectedVersion', 'method', deposit ? 'expectedProposalId' : 'amount'];
	if (
		[...form.keys()].some((key) => !fields.includes(key)) ||
		fields.some((key) => form.getAll(key).length !== 1 || typeof form.get(key) !== 'string')
	)
		return null;
	const expectedVersion = form.get('expectedVersion') as string;
	const method = form.get('method') as ManualPaymentMethod;
	if (
		!/^[1-9]\d*$/.test(expectedVersion) ||
		Number(expectedVersion) > 2_147_483_647 ||
		!manualPaymentMethods.includes(method)
	)
		return null;
	if (deposit) {
		const expectedProposalId = form.get('expectedProposalId') as string;
		if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(expectedProposalId))
			return null;
		return { expectedVersion, method, expectedProposalId };
	}
	const amount = form.get('amount') as string;
	if (amount.length > 100) return null;
	return { expectedVersion, method, amount };
}
export function paymentErrorMessage(status: number, mutationAttempted = false): string {
	if (status === 403) return 'This account cannot record payments.';
	if (status === 404)
		return 'This request or document is no longer available. Reload to review the latest state.';
	if (status === 409)
		return 'This proposal, document or payment state changed. Reload to review the latest state before trying again.';
	if (status === 400 || status === 422)
		return 'Enter a valid payment amount and manual payment method.';
	if (status >= 500 && mutationAttempted)
		return 'We couldn’t confirm whether the payment was recorded. Reload to review the latest state before trying again.';
	return 'We couldn’t review this request for payment. Reload before trying again.';
}
