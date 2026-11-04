import { describe, expect, it } from 'vitest';
import {
	amountProblemMessage,
	decimalToCents,
	formatCents,
	parseUsdInput,
	validatePartialAmount
} from './money.js';

describe('exact money', () => {
	it('converts commerce decimal strings to cents without rounding', () => {
		expect(decimalToCents('1200.00')).toBe(120000n);
		expect(decimalToCents('0.5')).toBe(50n);
		expect(decimalToCents('-12.30')).toBe(-1230n);
		expect(decimalToCents('7')).toBe(700n);
		expect(decimalToCents('1.230')).toBe(123n);
		expect(decimalToCents('1.234')).toBeNull();
		expect(decimalToCents('1e3')).toBeNull();
		expect(decimalToCents('0.1')).toBe(10n);
		expect(decimalToCents('')).toBeNull();
	});

	it('formats exactly, with grouping and sign', () => {
		expect(formatCents(123456789n)).toBe('$1,234,567.89');
		expect(formatCents(5n)).toBe('$0.05');
		expect(formatCents(-500n)).toBe('-$5.00');
		expect(formatCents(99_999_999n)).toBe('$999,999.99');
	});

	it('parses customer input into integer cents', () => {
		expect(parseUsdInput('250')).toEqual({ ok: true, cents: 25000n });
		expect(parseUsdInput(' $1,250.5 ')).toEqual({ ok: true, cents: 125050n });
		expect(parseUsdInput('.75')).toEqual({ ok: true, cents: 75n });
		expect(parseUsdInput('100.')).toEqual({ ok: true, cents: 10000n });
		expect(parseUsdInput('')).toEqual({ ok: false, problem: 'empty' });
		expect(parseUsdInput('12,34')).toEqual({ ok: false, problem: 'format' });
		expect(parseUsdInput('-5')).toEqual({ ok: false, problem: 'format' });
		expect(parseUsdInput('1e3')).toEqual({ ok: false, problem: 'format' });
		expect(parseUsdInput('10.005')).toEqual({ ok: false, problem: 'precision' });
		expect(parseUsdInput('0.1 + 0.2')).toEqual({ ok: false, problem: 'format' });
	});

	it('validates partial Invoice amounts against balance and Stripe limits', () => {
		const balance = 96000n;
		expect(validatePartialAmount('100', balance)).toEqual({ ok: true, cents: 10000n });
		expect(validatePartialAmount('960.00', balance)).toEqual({ ok: true, cents: 96000n });
		expect(validatePartialAmount('0', balance)).toEqual({ ok: false, problem: 'zero' });
		expect(validatePartialAmount('0.49', balance)).toEqual({ ok: false, problem: 'minimum' });
		expect(validatePartialAmount('0.50', balance)).toEqual({ ok: true, cents: 50n });
		expect(validatePartialAmount('960.01', balance)).toEqual({ ok: false, problem: 'balance' });
		expect(validatePartialAmount('10.123', balance)).toEqual({ ok: false, problem: 'precision' });
		const huge = 150_000_000n;
		expect(validatePartialAmount('999999.99', huge)).toEqual({ ok: true, cents: 99_999_999n });
		expect(validatePartialAmount('1000000', huge)).toEqual({ ok: false, problem: 'maximum' });
		expect(validatePartialAmount('9999999999999', huge)).toEqual({
			ok: false,
			problem: 'maximum'
		});
	});

	it('explains every problem in customer language', () => {
		expect(amountProblemMessage('minimum', 100n)).toContain('$0.50');
		expect(amountProblemMessage('balance', 96000n)).toContain('$960.00');
		expect(amountProblemMessage('maximum', 0n)).toContain('$999,999.99');
		expect(amountProblemMessage('precision', 0n)).toMatch(/two decimal places/);
	});
});
