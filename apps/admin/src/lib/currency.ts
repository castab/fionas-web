/**
 * Fiona's Ice Cream operates only in US dollars. Commerce is currency-generic by design; this
 * console is not. It validates every staff-entered amount as USD and refuses any other currency
 * instead of guessing its precision. There is no conversion and no currency selection.
 */
export const CURRENCY = 'USD';

/** USD minor units: flat amounts, tax and extended line subtotals settle to whole cents. */
export const CENT_DIGITS = 2;

export function isSupportedCurrency(value: unknown): value is typeof CURRENCY {
	return value === CURRENCY;
}
