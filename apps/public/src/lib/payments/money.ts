/**
 * Exact USD money for the customer payment page. Commerce sends major-unit decimal strings; every
 * comparison and conversion here uses BigInt cents, never floating point, and nothing is rounded.
 */

/** Stripe's per-transaction USD limits, which commerce also enforces independently. */
export const STRIPE_MIN_CENTS = 50n;
export const STRIPE_MAX_CENTS = 99_999_999n;

const DECIMAL = /^(-?)([0-9]+)(?:\.([0-9]+))?$/;

/**
 * Converts an exact decimal string ("1200.00", "-5", "0.5") to cents. Digits past the cent must be
 * zeros ("1.230" is fine, "1.234" is not representable and returns null): nothing is rounded.
 */
export function decimalToCents(value: string): bigint | null {
	const match = DECIMAL.exec(value);
	if (!match) return null;
	const [, sign, whole, fraction = ''] = match;
	if (whole.length > 15) return null;
	if (/[^0]/.test(fraction.slice(2))) return null;
	const cents = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0'));
	return sign === '-' ? -cents : cents;
}

/** "$1,234.56"; a negative amount reads "-$5.00". Exact: built from the digits, not Intl. */
export function formatCents(cents: bigint): string {
	const negative = cents < 0n;
	const absolute = negative ? -cents : cents;
	const whole = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	const fraction = (absolute % 100n).toString().padStart(2, '0');
	return `${negative ? '-' : ''}$${whole}.${fraction}`;
}

/** Formats a commerce decimal string, or returns null when it is not an exact USD amount. */
export function formatDecimal(value: string): string | null {
	const cents = decimalToCents(value);
	return cents === null ? null : formatCents(cents);
}

export type AmountProblem =
	'empty' | 'format' | 'precision' | 'zero' | 'minimum' | 'maximum' | 'balance';

/**
 * Parses what a customer typed as a dollar amount: "250", "250.5", "$1,250.00". Thousands
 * separators must be well formed. More than two decimal places is refused, never rounded.
 */
export function parseUsdInput(
	input: string
):
	| { ok: true; cents: bigint }
	| { ok: false; problem: 'empty' | 'format' | 'precision' | 'maximum' } {
	const trimmed = input.trim().replace(/^\$\s*/, '');
	if (trimmed === '') return { ok: false, problem: 'empty' };
	const grouped = /^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/.test(trimmed);
	const plain = trimmed.replace(/,/g, '');
	if ((trimmed.includes(',') && !grouped) || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(plain))
		return { ok: false, problem: 'format' };
	const [whole, fraction = ''] = plain.split('.');
	if (fraction.length > 2) return { ok: false, problem: 'precision' };
	if (whole.replace(/^0+/, '').length > 12) return { ok: false, problem: 'maximum' };
	return {
		ok: true,
		cents: BigInt(whole || '0') * 100n + BigInt(fraction.padEnd(2, '0'))
	};
}

/**
 * Validates a partial Invoice payment against the current outstanding balance (in cents) and
 * Stripe's limits. The backend checks again; this only keeps customers from sending a sure refusal.
 */
export function validatePartialAmount(
	input: string,
	balanceCents: bigint
): { ok: true; cents: bigint } | { ok: false; problem: AmountProblem } {
	const parsed = parseUsdInput(input);
	if (!parsed.ok) return parsed;
	const { cents } = parsed;
	if (cents <= 0n) return { ok: false, problem: 'zero' };
	if (cents < STRIPE_MIN_CENTS) return { ok: false, problem: 'minimum' };
	if (cents > balanceCents) return { ok: false, problem: 'balance' };
	if (cents > STRIPE_MAX_CENTS) return { ok: false, problem: 'maximum' };
	return { ok: true, cents };
}

export function amountProblemMessage(problem: AmountProblem, balanceCents: bigint): string {
	switch (problem) {
		case 'empty':
			return 'Enter the amount you would like to pay.';
		case 'format':
			return 'Enter a dollar amount, like 250 or 250.50.';
		case 'precision':
			return 'Use dollars and cents only, with no more than two decimal places.';
		case 'zero':
			return 'Enter an amount greater than $0.00.';
		case 'minimum':
			return `Online payments must be at least ${formatCents(STRIPE_MIN_CENTS)}.`;
		case 'balance':
			return `That's more than your remaining balance of ${formatCents(balanceCents)}.`;
		case 'maximum':
			return `Online payments can be at most ${formatCents(STRIPE_MAX_CENTS)} each. You can pay the rest in another payment.`;
	}
}
