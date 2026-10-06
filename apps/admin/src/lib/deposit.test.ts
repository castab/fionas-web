import { describe, expect, it } from 'vitest';
import {
	depositInputError,
	depositTermsLabel,
	isPercentage,
	isPositiveDecimal,
	matchesReviewedSuggestion,
	readDepositForm
} from './deposit.js';
import { resolveDepositAmount } from '../../e2e/request-fixture.mjs';

function form(entries: Record<string, string> = {}) {
	const data = new FormData();
	for (const [key, value] of Object.entries({
		expectedVersion: '1',
		depositChoice: 'suggested',
		reviewedSuggestionType: 'PERCENTAGE',
		reviewedSuggestionValue: '17.50',
		...entries
	}))
		data.append(key, value);
	return data;
}

describe('deposit form', () => {
	it.each(['0', '0.000', '-1', '+2', '1e2', 'NaN', 'Infinity', '1,000', '.5', '1.', ' 2', '2 '])(
		'rejects malformed/nonpositive decimal %s',
		(value) => {
			expect(isPositiveDecimal(value)).toBe(false);
			expect(isPercentage(value)).toBe(false);
		}
	);
	it.each(['0.001', '20.000', '00099.99', '100.000'])('accepts exact percentage %s', (value) =>
		expect(isPercentage(value)).toBe(true)
	);
	it.each(['100.00000000000000000001', '101', '999999999999999999999'])(
		'rejects out-of-range percentages %s',
		(value) => expect(isPercentage(value)).toBe(false)
	);
	it('preserves strings, rejects extra/duplicate/file fields and validates only the selected input', () => {
		const parsed = readDepositForm(
			form({ depositChoice: 'percentage', depositPercentage: '017.500', depositAmount: 'ignored' })
		)!;
		expect(parsed.depositPercentage).toBe('017.500');
		expect(depositInputError(parsed)).toBeNull();
		expect(readDepositForm(form({ currency: 'USD' }))).toBeNull();
		const duplicate = form();
		duplicate.append('depositChoice', 'fixed');
		expect(readDepositForm(duplicate)).toBeNull();
		const file = form();
		file.set('depositAmount', new Blob(['1']));
		expect(readDepositForm(file)).toBeNull();
		expect(
			depositInputError(
				readDepositForm(form({ depositChoice: 'percentage', depositPercentage: '101' }))!
			)
		).toBe('depositPercentage');
		expect(
			depositInputError(readDepositForm(form({ depositChoice: 'fixed', depositAmount: '0' }))!)
		).toBe('depositAmount');
	});
	it('uses supplied percentage or fixed suggestions, comparing exact reviewed terms', () => {
		const parsed = readDepositForm(form())!;
		expect(matchesReviewedSuggestion(parsed, { type: 'PERCENTAGE', percentage: '17.50' })).toBe(
			true
		);
		expect(matchesReviewedSuggestion(parsed, { type: 'PERCENTAGE', percentage: '25' })).toBe(false);
		expect(depositTermsLabel({ type: 'PERCENTAGE', percentage: '17.50' })).toBe('17.50% of quote');
		expect(depositTermsLabel({ type: 'FIXED', amount: '123.45', currency: 'USD' })).toContain(
			'$123.45'
		);
	});
	it('resolves fixture deposits exactly with HALF_UP currency rounding', () => {
		expect(resolveDepositAmount('415.00', { type: 'PERCENTAGE', percentage: '20' }, 'USD')).toBe(
			'83.00'
		);
		expect(resolveDepositAmount('0.05', { type: 'PERCENTAGE', percentage: '10' }, 'USD')).toBe(
			'0.01'
		);
		expect(resolveDepositAmount('415.00', { type: 'PERCENTAGE', percentage: '17.50' }, 'USD')).toBe(
			'72.63'
		);
		expect(
			resolveDepositAmount('415.00', { type: 'FIXED', amount: '123.40', currency: 'USD' }, 'USD')
		).toBe('123.40');
		expect(() =>
			resolveDepositAmount('415.00', { type: 'FIXED', amount: '1.001', currency: 'USD' }, 'USD')
		).toThrow();
	});
});
