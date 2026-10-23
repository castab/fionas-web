import {
	GROUP_MAX,
	KEY_MAX,
	LABEL_MAX,
	MAX_SELECTIONS,
	canonicalSelection,
	isPlaceholder,
	isServicePlanItem,
	isServicePlanItems,
	selectionDrafts,
	type SelectionDraft
} from './service-selections.js';
import {
	readDepositForm,
	depositInputError,
	isDepositTerms,
	type DepositFormValues
} from './deposit.js';
import { CENT_DIGITS, CURRENCY, isSupportedCurrency } from './currency.js';
import type { CurrentStaffRequest, DepositTermsRequest } from './request-contract.js';
import type { QuoteCommand, ProposedLine, InquiryQuotePreviewResponse } from './quote-contract.js';

export type { SelectionDraft };
export type LineDraft = ProposedLine & { note: string };
export type QuoteFormValues = {
	deposit: DepositFormValues;
	lines: LineDraft[];
	description: string;
	guestCount: string;
	items: SelectionDraft[];
	/** The reviewed document's currency, echoed by the page. Only USD is accepted. */
	reviewedCurrency: typeof CURRENCY;
	reviewToken: string;
	reviewedFingerprint: string;
};
export type QuoteActionResult = {
	quoteValues?: QuoteFormValues;
	preview?: InquiryQuotePreviewResponse;
	quoteError?: string;
	reviewRequired?: boolean;
	fieldErrors?: Record<string, string>;
	notices?: { reviewStale?: boolean };
};
export function initialQuoteValues(data: CurrentStaffRequest): QuoteFormValues {
	const service = data.inquiry.requestedService;
	const terms = data.suggestedDepositTerms;
	return {
		deposit: {
			expectedVersion: String(data.financial.version),
			depositChoice: 'suggested',
			reviewedSuggestionType: terms.type,
			reviewedSuggestionValue: terms.type === 'PERCENTAGE' ? terms.percentage : terms.amount,
			depositPercentage: '',
			depositAmount: ''
		},
		lines: data.financial.lines.map((l) => ({
			lineItemId: l.id,
			description: l.description,
			subDescription: l.subDescription,
			quantity: l.quantity,
			unitPrice: l.unitPrice,
			taxAmount: l.taxAmount,
			currency: l.currency,
			note: ''
		})),
		description: 'Ice cream service',
		guestCount: String(service.guestCount),
		// An independent draft of the customer's picks, in their order, with categories and keys.
		items: selectionDrafts(service.items),
		reviewedCurrency: CURRENCY,
		reviewToken: '',
		reviewedFingerprint: ''
	};
}
export function reviewedTerms(values: DepositFormValues): DepositTermsRequest {
	return values.depositChoice === 'percentage'
		? { type: 'PERCENTAGE', percentage: values.depositPercentage.trim() }
		: values.depositChoice === 'fixed'
			? { type: 'FIXED', amount: values.depositAmount.trim(), currency: CURRENCY }
			: values.reviewedSuggestionType === 'PERCENTAGE'
				? { type: 'PERCENTAGE', percentage: values.reviewedSuggestionValue }
				: { type: 'FIXED', amount: values.reviewedSuggestionValue, currency: CURRENCY };
}
export function readQuoteForm(form: FormData): QuoteFormValues | null {
	const scalar = (name: string) => {
		const a = form.getAll(name);
		return a.length <= 1 && (a.length === 0 || typeof a[0] === 'string')
			? String(a[0] ?? '')
			: null;
	};
	const depositForm = new FormData();
	for (const key of [
		'expectedVersion',
		'depositChoice',
		'reviewedSuggestionType',
		'reviewedSuggestionValue',
		'depositPercentage',
		'depositAmount'
	])
		for (const value of form.getAll(key)) depositForm.append(key, value);
	const deposit = readDepositForm(depositForm);
	if (!deposit) return null;
	// The page echoes the currency it reviewed; anything but USD is refused before any backend call.
	// It never selects validation rules: those are USD's, whatever the browser sends.
	if (!isSupportedCurrency(scalar('reviewedCurrency'))) return null;
	const rows = form.getAll('lineIdentity');
	const names = ['description', 'subDescription', 'quantity', 'unitPrice', 'taxAmount', 'note'];
	if (rows.length > 101 || names.some((n) => form.getAll(n).length !== rows.length)) return null;
	const lines: LineDraft[] = [];
	for (let i = 0; i < rows.length; i++) {
		const identity = rows[i];
		if (typeof identity !== 'string') return null;
		const entries = Object.fromEntries(names.map((n) => [n, form.getAll(n)[i]]));
		if (Object.values(entries).some((v) => typeof v !== 'string')) return null;
		if (
			identity.startsWith('new:') &&
			!String(entries.description).trim() &&
			!String(entries.unitPrice).trim()
		)
			continue;
		const id =
			identity === 'new:blank-row'
				? crypto.randomUUID()
				: identity.substring(identity.indexOf(':') + 1);
		if (
			identity.startsWith('id:')
				? !/^[0-9a-f-]{36}$/i.test(id)
				: !identity.startsWith('new:') || !/^[A-Za-z0-9_-]{1,64}$/.test(id)
		)
			return null;
		const text = (name: string) => String(entries[name]).trim();
		lines.push({
			...(identity.startsWith('id:') ? { lineItemId: id } : { key: id }),
			description: text('description'),
			...(text('subDescription') ? { subDescription: text('subDescription') } : {}),
			...(text('quantity') ? { quantity: text('quantity') } : {}),
			unitPrice: text('unitPrice'),
			taxAmount: text('taxAmount'),
			currency: CURRENCY,
			note: text('note')
		});
	}
	const selections = readSelections(form, scalar);
	if (!selections) return null;
	const { items, fields: selectionFields } = selections;
	const other = ['planDescription', 'planGuestCount', 'reviewToken', 'reviewedFingerprint'];
	const vals = other.map(scalar);
	if (vals.some((v) => v === null)) return null;
	const allowed = new Set([
		...other,
		'reviewedCurrency',
		'lineIdentity',
		...names,
		...depositForm.keys(),
		'rowAction',
		'selectionAction',
		'selectionIdentity',
		...selectionFields
	]);
	if (form.has('rowAction') && form.has('selectionAction')) return null;
	if ([...form.keys()].some((k) => !allowed.has(k))) return null;
	// Native controls perform the same reversible row edits as JavaScript.
	const action = scalar('rowAction');
	if (action === null || (action && !/^(remove|up|down):[0-9]+$/.test(action))) return null;
	if (action) {
		const [kind, index] = action.split(':');
		const i = Number(index);
		if (!Number.isInteger(i) || i < 0 || i >= lines.length) return null;
		if (kind === 'remove') lines.splice(i, 1);
		else if (kind === 'up' && i > 0) [lines[i - 1], lines[i]] = [lines[i], lines[i - 1]];
		else if (kind === 'down' && i < lines.length - 1)
			[lines[i + 1], lines[i]] = [lines[i], lines[i + 1]];
		else return null;
	}
	return {
		deposit,
		lines,
		description: vals[0]!,
		guestCount: vals[1]!,
		items,
		reviewToken: vals[2]!,
		reviewedFingerprint: vals[3]!,
		reviewedCurrency: CURRENCY
	};
}

function exact(value: string, maxFraction: number): boolean {
	return new RegExp(`^-?[0-9]{1,9}(\\.[0-9]{1,${maxFraction}})?$`).test(value);
}
function units(value: string): bigint {
	const negative = value.startsWith('-');
	const [whole, fraction = ''] = value.replace('-', '').split('.');
	const n = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
	return negative ? -n : n;
}
/**
 * Staff input checks, all in USD. Flat prices and tax are whole cents; a per-unit rate may carry up
 * to 12 fractional digits when rate × quantity settles exactly to cents. Amounts may be signed
 * (discounts and credits). Nothing is ever rounded: an amount that doesn't settle is refused.
 */
const SELECTION_ROW = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * Selection rows are aligned by identity: `selectionIdentity` lists the overall order, and each
 * identity owns exactly one label, category, source key and source label field. Text is kept as
 * typed so a re-rendered draft never trims under the cursor; `buildCommand` canonicalizes it.
 */
function readSelections(form: FormData, scalar: (name: string) => string | null) {
	const identities = form.getAll('selectionIdentity');
	if (identities.length > MAX_SELECTIONS) return null;
	const fields: string[] = [];
	const items: SelectionDraft[] = [];
	for (const identity of identities) {
		if (typeof identity !== 'string' || !SELECTION_ROW.test(identity)) return null;
		const names = ['selectionLabel', 'selectionGroup', 'selectionKey', 'selectionSource'].map(
			(n) => `${n}:${identity}`
		);
		if (fields.includes(names[0])) return null;
		fields.push(...names);
		const [label, group, key, sourceLabel] = names.map(scalar);
		if (
			label === null ||
			group === null ||
			key === null ||
			sourceLabel === null ||
			label.trim().length > LABEL_MAX ||
			group.trim().length > GROUP_MAX ||
			key.trim().length > KEY_MAX ||
			sourceLabel.trim().length > LABEL_MAX ||
			names.some((n) => !form.has(n))
		)
			return null;
		items.push({ rowId: identity, label, group, key: key.trim() || null, sourceLabel });
	}
	// Selection edits have their own action namespace; financial rows use `rowAction`.
	const action = scalar('selectionAction');
	if (action === null) return null;
	if (action === 'add') {
		if (items.length >= MAX_SELECTIONS) return null;
		items.push({ rowId: crypto.randomUUID(), label: '', group: '', key: null, sourceLabel: '' });
	} else if (action) {
		const match = /^(remove|up|down):([A-Za-z0-9_-]{1,64})$/.exec(action);
		const i = match ? items.findIndex((item) => item.rowId === match[2]) : -1;
		if (!match || i < 0) return null;
		if (match[1] === 'remove') items.splice(i, 1);
		else {
			const j = i + (match[1] === 'up' ? -1 : 1);
			if (j < 0 || j >= items.length) return null;
			[items[i], items[j]] = [items[j], items[i]];
		}
	}
	return { items, fields };
}
/** Unused blank placeholder rows are dropped; everything else is part of the commitment. */
const committedSelections = (items: SelectionDraft[]) => items.filter((i) => !isPlaceholder(i));
export function quoteInputErrors(values: QuoteFormValues): Record<string, string> {
	const errors: Record<string, string> = {};
	const cents = (s: string) => exact(s, CENT_DIGITS);
	if (!values.lines.length || values.lines.length > 100) errors.lines = 'Supply 1–100 final lines.';
	if (new Set(values.lines.map((l) => l.lineItemId ?? l.key)).size !== values.lines.length)
		errors.lines = 'Each line needs a unique identity.';
	values.lines.forEach((l, i) => {
		if (
			!l.description ||
			l.description.length > 200 ||
			(l.subDescription?.length ?? 0) > 500 ||
			l.note.length > 500 ||
			!isSupportedCurrency(l.currency) ||
			!exact(l.unitPrice, l.quantity ? 12 : CENT_DIGITS) ||
			!cents(l.taxAmount) ||
			(l.quantity && (!exact(l.quantity, 6) || units(l.quantity) === 0n))
		) {
			errors[`line-${i}`] = 'Check the description, exact amount, quantity and tax.';
			return;
		}
		const subtotal = l.quantity
			? (units(l.unitPrice) * units(l.quantity)) / 10n ** 18n
			: units(l.unitPrice);
		if (subtotal % 10n ** BigInt(18 - CENT_DIGITS) !== 0n)
			errors[`line-${i}`] = 'This rate and quantity do not settle exactly; no rounding is allowed.';
	});
	const count = (s: string, max: number) => !s || (/^[1-9]\d*$/.test(s) && Number(s) <= max);
	if (values.description.length > 2000 || !count(values.guestCount, 100000))
		errors.service = 'Check the approved service description and counts.';
	if (values.items.length > MAX_SELECTIONS)
		errors.selections = `A serving plan lists at most ${MAX_SELECTIONS} selections.`;
	// Keyed by draft position, which the editor shows; selection errors never touch line totals.
	values.items.forEach((item, i) => {
		if (isPlaceholder(item)) return;
		const name = `Selection ${i + 1}`;
		if (!item.label.trim())
			errors[`selection-${i}`] = `${name} needs a label. Remove it if it isn’t needed.`;
		else if (!isServicePlanItem(canonicalSelection(item)))
			errors[`selection-${i}`] =
				`${name}: keep the label to ${LABEL_MAX} characters and the category to ${GROUP_MAX}.`;
	});
	if (!values.description.trim() && values.lines.some((l) => l.note.trim()))
		errors.service = 'Add a service description to preserve the line notes with this quote.';
	if (depositInputError(values.deposit) || !isDepositTerms(reviewedTerms(values.deposit), CURRENCY))
		errors.deposit = 'Check deposit terms.';
	return errors;
}
export function buildCommand(values: QuoteFormValues): QuoteCommand {
	const lines = values.lines.map(({ note, ...line }) => {
		void note;
		return line;
	});
	const description = values.description.trim();
	return {
		lines,
		...(description
			? {
					servicePlan: {
						description,
						...(values.guestCount ? { guestCount: Number(values.guestCount) } : {}),
						// Exactly the reviewed order; editor row IDs never leave the admin.
						items: committedSelections(values.items).map(canonicalSelection),
						lineNotes: values.lines
							.filter((l) => l.note)
							.map((l) => ({
								...(l.lineItemId ? { lineItemId: l.lineItemId } : { key: l.key }),
								note: l.note
							}))
					}
				}
			: {})
	};
}
/** The preview must describe exactly the selections the command proposed, in order. */
export function previewMatchesSelections(
	command: QuoteCommand,
	preview: InquiryQuotePreviewResponse
): boolean {
	if (!command.servicePlan) return true;
	const proposed = command.servicePlan.items ?? [];
	const shown = preview.servicePlan?.items;
	return (
		!!shown &&
		shown.length === proposed.length &&
		shown.every(
			(item, i) =>
				item.label === proposed[i].label &&
				(item.group ?? null) === (proposed[i].group ?? null) &&
				(item.key ?? null) === (proposed[i].key ?? null)
		)
	);
}
export function isQuotePreview(
	value: unknown,
	scope: { inquiryId: string; documentId?: string }
): value is InquiryQuotePreviewResponse {
	if (!value || typeof value !== 'object') return false;
	const p = value as InquiryQuotePreviewResponse;
	const amount = (v: unknown) => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);
	return (
		p.inquiryId === scope.inquiryId &&
		(!scope.documentId || p.documentId === scope.documentId) &&
		isSupportedCurrency(p.currency) &&
		Number.isInteger(p.reviewedDocumentVersion) &&
		p.reviewedDocumentVersion > 0 &&
		Number.isInteger(p.quoteVersion) &&
		p.quoteVersion > p.reviewedDocumentVersion &&
		typeof p.financialChange === 'boolean' &&
		typeof p.reviewToken === 'string' &&
		/^[a-f0-9]{64}$/.test(p.reviewToken) &&
		[p.estimateTotal, p.subtotal, p.taxAmount, p.total].every(amount) &&
		Array.isArray(p.lines) &&
		p.lines.length > 0 &&
		p.lines.every((l) => l && typeof l === 'object') &&
		new Set(p.lines.map((l) => l.id)).size === p.lines.length &&
		p.lines.every(
			(l) =>
				typeof l.id === 'string' &&
				!!l.id &&
				['CARRIED', 'REPLACED', 'NEW'].includes(l.origin) &&
				typeof l.description === 'string' &&
				l.currency === p.currency &&
				[l.unitPrice, l.subtotal, l.taxAmount, l.total].every(amount)
		) &&
		(p.servicePlan == null ||
			(typeof p.servicePlan.description === 'string' &&
				!!p.servicePlan.description.trim() &&
				p.servicePlan.description.length <= 2000 &&
				isServicePlanItems(p.servicePlan.items))) &&
		!!p.deposit &&
		isDepositTerms(p.deposit.terms, p.currency) &&
		amount(p.deposit.requiredAmount?.amount) &&
		p.deposit.requiredAmount.currency === p.currency
	);
}
