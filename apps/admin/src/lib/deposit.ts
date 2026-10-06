import type { DepositTermsRequest } from './request-contract.js';
import { formatMoney } from './presentation.js';

export function isPositiveDecimal(value: unknown): value is string {
	return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) && /[1-9]/.test(value);
}

export function isPercentage(value: unknown): value is string {
	if (!isPositiveDecimal(value)) return false;
	const [whole, fraction = ''] = value.split('.');
	const integer = whole.replace(/^0+/, '') || '0';
	return integer.length < 3 || (integer === '100' && !/[1-9]/.test(fraction));
}

export function isDepositTerms(value: unknown, currency: string): value is DepositTermsRequest {
	if (!value || typeof value !== 'object') return false;
	const terms = value as Record<string, unknown>;
	return terms.type === 'PERCENTAGE'
		? Object.keys(terms).length === 2 && isPercentage(terms.percentage)
		: terms.type === 'FIXED' &&
				Object.keys(terms).length === 3 &&
				isPositiveDecimal(terms.amount) &&
				terms.currency === currency;
}

export function suggestionValue(terms: DepositTermsRequest): string {
	return terms.type === 'PERCENTAGE' ? terms.percentage : terms.amount;
}

export function depositTermsLabel(terms: DepositTermsRequest): string {
	return terms.type === 'PERCENTAGE'
		? `${terms.percentage}% of quote`
		: `Fixed deposit · ${formatMoney(terms.amount, terms.currency)}`;
}

export type DepositChoice = 'suggested' | 'percentage' | 'fixed';
export type DepositFormValues = {
	expectedVersion: string;
	depositChoice: DepositChoice;
	reviewedSuggestionType: DepositTermsRequest['type'];
	reviewedSuggestionValue: string;
	depositPercentage: string;
	depositAmount: string;
};
export type DepositErrorField = 'depositPercentage' | 'depositAmount' | 'depositChoice';

/** Strict UI envelope; inactive native inputs may be present but never enter the command. */
export function readDepositForm(form: FormData): DepositFormValues | null {
	const required = [
		'expectedVersion',
		'depositChoice',
		'reviewedSuggestionType',
		'reviewedSuggestionValue'
	];
	const allowed = [...required, 'depositPercentage', 'depositAmount'];
	if ([...form.keys()].some((key) => !allowed.includes(key))) return null;
	if (
		allowed.some(
			(key) => form.getAll(key).length > 1 || (form.has(key) && typeof form.get(key) !== 'string')
		)
	)
		return null;
	if (required.some((key) => !form.has(key))) return null;
	const expectedVersion = form.get('expectedVersion') as string;
	const depositChoice = form.get('depositChoice') as DepositChoice;
	const reviewedSuggestionType = form.get('reviewedSuggestionType') as DepositTermsRequest['type'];
	const reviewedSuggestionValue = form.get('reviewedSuggestionValue') as string;
	if (!/^[1-9]\d*$/.test(expectedVersion) || Number(expectedVersion) > 2_147_483_647) return null;
	if (!['suggested', 'percentage', 'fixed'].includes(depositChoice)) return null;
	if (
		reviewedSuggestionType === 'PERCENTAGE'
			? !isPercentage(reviewedSuggestionValue)
			: reviewedSuggestionType !== 'FIXED' || !isPositiveDecimal(reviewedSuggestionValue)
	)
		return null;
	return {
		expectedVersion,
		depositChoice,
		reviewedSuggestionType,
		reviewedSuggestionValue,
		depositPercentage: (form.get('depositPercentage') as string | null) ?? '',
		depositAmount: (form.get('depositAmount') as string | null) ?? ''
	};
}

export function depositInputError(values: DepositFormValues): DepositErrorField | null {
	if (values.depositChoice === 'percentage' && !isPercentage(values.depositPercentage))
		return 'depositPercentage';
	if (values.depositChoice === 'fixed' && !isPositiveDecimal(values.depositAmount))
		return 'depositAmount';
	return null;
}

export function matchesReviewedSuggestion(
	values: DepositFormValues,
	terms: DepositTermsRequest
): boolean {
	return (
		values.reviewedSuggestionType === terms.type &&
		values.reviewedSuggestionValue === suggestionValue(terms)
	);
}
