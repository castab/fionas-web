import type { QuoteFormValues } from './quote-builder.js';

/** The form a browser posts for a draft, as the page's hidden fields and controls would. */
export function postedForm(values: QuoteFormValues, extra: Record<string, string> = {}) {
	const f = new FormData();
	f.set('editorMode', values.mode);
	f.set('expectedVersion', values.expectedVersion);
	f.set('expectedDepositRevision', values.expectedDepositRevision);
	f.set('expectedProposalId', values.expectedProposalId);
	f.set('expectedPlanRevision', values.expectedPlanRevision);
	if (values.clearPlan) f.set('clearPlan', 'on');
	if (values.deposit)
		for (const [k, v] of Object.entries(values.deposit)) if (k !== 'expectedVersion') f.set(k, v);
	f.set('reviewedCurrency', 'USD');
	f.set('planDescription', values.description);
	f.set('planGuestCount', values.guestCount);
	f.set('reviewToken', values.reviewToken);
	f.set('reviewedFingerprint', values.reviewedFingerprint);
	for (const item of values.items) {
		f.append('selectionIdentity', item.rowId);
		f.set(`selectionLabel:${item.rowId}`, item.label);
		f.set(`selectionGroup:${item.rowId}`, item.group);
		f.set(`selectionKey:${item.rowId}`, item.key ?? '');
		f.set(`selectionSource:${item.rowId}`, item.sourceLabel);
	}
	for (const l of values.lines) {
		f.append('lineIdentity', l.lineItemId ? `id:${l.lineItemId}` : `new:${l.key}`);
		for (const k of [
			'description',
			'subDescription',
			'quantity',
			'unitPrice',
			'taxAmount',
			'note'
		] as const)
			f.append(k, l[k] ?? '');
	}
	for (const [k, v] of Object.entries(extra)) f.set(k, v);
	return f;
}
