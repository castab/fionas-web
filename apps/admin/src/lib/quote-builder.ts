import {
	readDepositForm,
	depositInputError,
	isDepositTerms,
	type DepositFormValues
} from './deposit.js';
import type { CurrentStaffRequest, DepositTermsRequest } from './request-contract.js';
import type { QuoteCommand, ProposedLine, InquiryQuotePreviewResponse } from './quote-contract.js';

export type LineDraft = ProposedLine & { note: string };
export type QuoteFormValues = {
	deposit: DepositFormValues;
	lines: LineDraft[];
	description: string;
	guestCount: string;
	durationMinutes: string;
	items: string;
	reviewedCurrency: string;
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
		durationMinutes: String(service.durationMinutes ?? ''),
		items: service.items.map((i) => i.label).join('\n'),
		reviewedCurrency: data.financial.currency,
		reviewToken: '',
		reviewedFingerprint: ''
	};
}
export function reviewedTerms(values: DepositFormValues, currency: string): DepositTermsRequest {
	return values.depositChoice === 'percentage'
		? { type: 'PERCENTAGE', percentage: values.depositPercentage.trim() }
		: values.depositChoice === 'fixed'
			? { type: 'FIXED', amount: values.depositAmount.trim(), currency }
			: values.reviewedSuggestionType === 'PERCENTAGE'
				? { type: 'PERCENTAGE', percentage: values.reviewedSuggestionValue }
				: { type: 'FIXED', amount: values.reviewedSuggestionValue, currency };
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
	const currency = scalar('reviewedCurrency');
	if (!currency || !/^[A-Z]{3}$/.test(currency)) return null;
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
			currency,
			note: text('note')
		});
	}
	const other = [
		'planDescription',
		'planGuestCount',
		'planDuration',
		'planItems',
		'reviewToken',
		'reviewedFingerprint'
	];
	const vals = other.map(scalar);
	if (vals.some((v) => v === null)) return null;
	const allowed = new Set([
		...other,
		'reviewedCurrency',
		'lineIdentity',
		...names,
		...depositForm.keys(),
		'rowAction'
	]);
	if ([...form.keys()].some((k) => !allowed.has(k))) return null;
	// Native controls perform the same reversible row edits as JavaScript.
	const action = scalar('rowAction');
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
		durationMinutes: vals[2]!,
		items: vals[3]!,
		reviewToken: vals[4]!,
		reviewedFingerprint: vals[5]!,
		reviewedCurrency: currency
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
export function quoteInputErrors(
	values: QuoteFormValues,
	currency: string
): Record<string, string> {
	const errors: Record<string, string> = {};
	const minor = currency === 'JPY' ? 0 : currency === 'BHD' ? 3 : 2;
	const minorExact = (s: string) => (minor === 0 ? /^-?\d{1,9}$/.test(s) : exact(s, minor));
	if (!values.lines.length || values.lines.length > 100) errors.lines = 'Supply 1–100 final lines.';
	if (new Set(values.lines.map((l) => l.lineItemId ?? l.key)).size !== values.lines.length)
		errors.lines = 'Each line needs a unique identity.';
	values.lines.forEach((l, i) => {
		if (
			!l.description ||
			l.description.length > 200 ||
			(l.subDescription?.length ?? 0) > 500 ||
			l.note.length > 500 ||
			l.currency !== currency ||
			!exact(l.unitPrice, l.quantity ? 12 : Math.max(minor, 1)) ||
			(!l.quantity && !minorExact(l.unitPrice)) ||
			!minorExact(l.taxAmount) ||
			(l.quantity && (!exact(l.quantity, 6) || units(l.quantity) === 0n))
		) {
			errors[`line-${i}`] = 'Check the description, exact amount, quantity and tax.';
			return;
		}
		const subtotal = l.quantity
			? (units(l.unitPrice) * units(l.quantity)) / 10n ** 18n
			: units(l.unitPrice);
		if (subtotal % 10n ** BigInt(18 - minor) !== 0n)
			errors[`line-${i}`] = 'This rate and quantity do not settle exactly; no rounding is allowed.';
	});
	const count = (s: string, max: number) => !s || (/^[1-9]\d*$/.test(s) && Number(s) <= max);
	if (
		values.description.length > 2000 ||
		!count(values.guestCount, 100000) ||
		!count(values.durationMinutes, 1440) ||
		values.items.split('\n').filter(Boolean).length > 50 ||
		values.items.split('\n').some((s) => s.length > 200)
	)
		errors.service = 'Check the approved service description and counts.';
	if (!values.description.trim() && values.lines.some((l) => l.note.trim()))
		errors.service = 'Add a service description to preserve the line notes with this quote.';
	if (
		depositInputError(values.deposit) ||
		!isDepositTerms(reviewedTerms(values.deposit, currency), currency)
	)
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
						...(values.durationMinutes ? { durationMinutes: Number(values.durationMinutes) } : {}),
						items: values.items
							.split('\n')
							.map((s) => s.trim())
							.filter(Boolean),
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
export function isQuotePreview(
	value: unknown,
	scope: { inquiryId: string; currency: string; documentId?: string }
): value is InquiryQuotePreviewResponse {
	if (!value || typeof value !== 'object') return false;
	const p = value as InquiryQuotePreviewResponse;
	const amount = (v: unknown) => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);
	return (
		p.inquiryId === scope.inquiryId &&
		(!scope.documentId || p.documentId === scope.documentId) &&
		p.currency === scope.currency &&
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
		!!p.deposit &&
		isDepositTerms(p.deposit.terms, p.currency) &&
		amount(p.deposit.requiredAmount?.amount) &&
		p.deposit.requiredAmount.currency === p.currency
	);
}
