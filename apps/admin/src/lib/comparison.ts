import { formatMoney } from './presentation.js';

const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const SCALE = 18;
function scaled(value: string): bigint {
	const negative = value.startsWith('-');
	const [whole, fraction = ''] = value.replace('-', '').split('.');
	const n =
		BigInt(whole) * 10n ** BigInt(SCALE) + BigInt(fraction.padEnd(SCALE, '0').slice(0, SCALE));
	return negative ? -n : n;
}

/**
 * `after − before` as an exact decimal string, for presentation only. It carries no business
 * meaning: every total, balance and settlement shown beside it comes from the backend.
 */
export function decimalDifference(before: string, after: string): string | null {
	if (!DECIMAL.test(before) || !DECIMAL.test(after)) return null;
	const delta = scaled(after) - scaled(before);
	const negative = delta < 0n;
	const magnitude = (negative ? -delta : delta).toString().padStart(SCALE + 1, '0');
	const whole = magnitude.slice(0, -SCALE);
	const fraction = magnitude.slice(-SCALE).replace(/0+$/, '').padEnd(2, '0');
	return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** "+$250.00", "−$50.00" or "No change" for a difference produced by `decimalDifference`. */
export function changeLabel(difference: string | null, currency: string): string {
	if (difference === null) return '—';
	if (/^-?0+(?:\.0+)?$/.test(difference)) return 'No change';
	const negative = difference.startsWith('-');
	return `${negative ? '−' : '+'}${formatMoney(negative ? difference.slice(1) : difference, currency)}`;
}
