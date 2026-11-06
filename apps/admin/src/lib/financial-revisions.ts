import type { InquiryInvoiceAmendmentResponse, StaffRequestResponse } from './request-contract.js';

export const isBusinessRevision = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;

export function isInvoiceAmendment(
	value: unknown,
	inquiryId: string,
	documentId: unknown
): value is InquiryInvoiceAmendmentResponse {
	if (!value || typeof value !== 'object') return false;
	const a = value as InquiryInvoiceAmendmentResponse;
	return (
		typeof a.id === 'string' &&
		!!a.id &&
		a.inquiryId === inquiryId &&
		typeof documentId === 'string' &&
		a.documentId === documentId &&
		isBusinessRevision(a.invoiceRevision) &&
		isBusinessRevision(a.documentVersion) &&
		(a.servicePlanRevision == null || isBusinessRevision(a.servicePlanRevision)) &&
		typeof a.approvedAt === 'string' &&
		/^\d{4}-\d\d-\d\dT/.test(a.approvedAt) &&
		Number.isFinite(Date.parse(a.approvedAt)) &&
		typeof a.financialChange === 'boolean' &&
		typeof a.servicePlanChange === 'boolean' &&
		(a.kind === 'INITIAL'
			? a.approvedBy == null && !a.financialChange && !a.servicePlanChange
			: a.kind === 'AMENDED' &&
				typeof a.approvedBy === 'string' &&
				!!a.approvedBy &&
				(a.financialChange || a.servicePlanChange))
	);
}

/** Validate business identities independently of the ledger, then check their snapshot references. */
export function isCoherentBusinessRevisionState(data: StaffRequestResponse): boolean {
	const {
		inquiry,
		financial,
		proposal,
		currentQuoteRevision,
		acceptedQuoteRevision,
		currentInvoiceRevision,
		invoiceAmendmentHistory: history
	} = data;
	if (!Array.isArray(history)) return false;
	if (
		currentQuoteRevision != null &&
		(!isBusinessRevision(currentQuoteRevision) || currentQuoteRevision !== proposal?.quoteRevision)
	)
		return false;
	if (financial.stage !== 'INVOICE')
		return currentInvoiceRevision == null && acceptedQuoteRevision == null && history.length === 0;
	if (
		acceptedQuoteRevision != null &&
		(!isBusinessRevision(acceptedQuoteRevision) ||
			acceptedQuoteRevision !== proposal?.quoteRevision)
	)
		return false;
	const latest = history.at(-1);
	if (
		!latest ||
		!Array.isArray(data.servicePlanHistory) ||
		!history.every((a) => isInvoiceAmendment(a, inquiry.id, financial.id)) ||
		new Set(history.map((a) => a.id)).size !== history.length ||
		latest.documentVersion !== financial.version ||
		(latest.servicePlanRevision ?? null) !== (data.effectiveServicePlan?.revision ?? null) ||
		(currentInvoiceRevision != null &&
			(!isBusinessRevision(currentInvoiceRevision) ||
				currentInvoiceRevision !== latest.invoiceRevision))
	)
		return false;
	const planRevisions = new Set(data.servicePlanHistory.map((plan) => plan?.revision));
	return history.every((a, i) => {
		if (a.servicePlanRevision != null && !planRevisions.has(a.servicePlanRevision)) return false;
		const previous = history[i - 1];
		return previous
			? a.kind === 'AMENDED' &&
					a.invoiceRevision === previous.invoiceRevision + 1 &&
					a.documentVersion === previous.documentVersion + (a.financialChange ? 1 : 0) &&
					((a.servicePlanRevision ?? null) !== (previous.servicePlanRevision ?? null)) ===
						a.servicePlanChange
			: a.kind === 'INITIAL' &&
					a.documentVersion > (proposal?.documentVersion ?? 0) &&
					(a.servicePlanRevision ?? null) === (proposal?.servicePlanRevision ?? null);
	});
}
