import {
	draftServiceInputs,
	isSelectable,
	type EstimateLine,
	type EstimatePreview,
	type InquiryAnswers,
	type InquiryForm,
	type OfferingOption
} from './inquiry.ts';

/** Exact pricing from the public projection. The browser uses it for advisory display;
 * the server uses its own projection from the validated private snapshot for submission. */

// Amounts are exact decimals in strings; do the sums in scaled integers so nothing drifts.
const SCALE = 18;
const ONE = 10n ** BigInt(SCALE);

function toUnits(amount: string): bigint {
	if (!/^-?[0-9]{1,9}(\.[0-9]{1,12})?$/.test(amount)) throw new Error('Invalid exact price');
	const negative = amount.startsWith('-');
	const [whole = '0', fraction = ''] = amount.replace(/^[-+]/, '').split('.');
	const scaled = BigInt(whole || '0') * ONE + BigInt(fraction.padEnd(SCALE, '0'));
	return negative ? -scaled : scaled;
}

/** Scaled integer back to a decimal string with at least two decimal places. */
function fromUnits(units: bigint): string {
	const negative = units < 0n;
	const abs = negative ? -units : units;
	const whole = abs / ONE;
	const fraction = (abs % ONE).toString().padStart(SCALE, '0').replace(/0+$/, '').padEnd(2, '0');
	return `${negative ? '-' : ''}${whole}.${fraction}`;
}

function line(
	currency: string,
	description: string,
	unit: bigint,
	quantity: number | null,
	subDescription?: string
): { line: EstimateLine; subtotal: bigint } {
	const subtotal = quantity === null ? unit : unit * BigInt(quantity);
	if (subtotal % 10n ** 16n !== 0n) throw new Error('Price does not settle in USD cents');
	return {
		subtotal,
		line: {
			description,
			...(subDescription ? { subDescription } : {}),
			...(quantity === null ? {} : { quantity: String(quantity) }),
			unitPrice: fromUnits(unit),
			subtotal: fromUnits(subtotal),
			taxAmount: '0.00',
			total: fromUnits(subtotal),
			currency
		}
	};
}

function findOffering(
	form: InquiryForm,
	category: string,
	key: string
): OfferingOption | undefined {
	for (const section of form.sections) {
		for (const field of section.fields) {
			if (field.input.type === 'OFFERING_CHOICE' && field.input.category === category) {
				return field.input.options.find((option) => option.key === key);
			}
		}
	}
	return undefined;
}

/** Code-owned wording, or undefined when it is absent, null or blank. */
const text = (value: string | null | undefined): string | undefined => value?.trim() || undefined;

/** The duration question's own label for this choice (e.g. "1½ hours"), as the chips show it. */
function durationLabel(form: InquiryForm, minutes: number): string | undefined {
	for (const section of form.sections) {
		for (const field of section.fields) {
			if (
				field.submissionPointer === '/serviceInputs/durationMinutes' &&
				field.input.type === 'INTEGER_CHOICE'
			) {
				return text(field.input.options.find((o) => o.value === minutes)?.label);
			}
		}
	}
	return undefined;
}

/**
 * The advisory estimate for the current answers, or null until guest count and service length are
 * known. Offerings not yet chosen simply contribute nothing, giving an "estimate so far".
 */
export function computeAdvisoryEstimate(
	form: InquiryForm,
	answers: InquiryAnswers
): EstimatePreview | null {
	const preview = form.pricingPreview;
	if (!preview) return null;
	const inputs = draftServiceInputs(form, answers);
	if (!inputs) return null;

	const duration = preview.durationOptions.find(
		(d) => d.durationMinutes === inputs.durationMinutes
	);
	if (!duration) return null;

	const { currency } = preview;
	const guests = inputs.guestCount;
	const lines: { line: EstimateLine; subtotal: bigint }[] = [
		line(
			currency,
			text(preview.baseServiceDescription) ?? 'Base service',
			toUnits(duration.baseServiceAmount),
			null,
			text(duration.baseServiceSubDescription) ??
				durationLabel(form, duration.durationMinutes) ??
				`${duration.durationMinutes} minutes`
		),
		line(
			currency,
			text(preview.perGuestDescription) ?? 'Ice cream service',
			toUnits(preview.perGuestAmount),
			guests,
			`${guests} ${guests === 1 ? 'guest' : 'guests'}`
		)
	];

	for (const selection of inputs.selections) {
		for (const key of selection.offerings) {
			const option = findOffering(form, selection.category, key);
			const price = option?.price;
			// Unpriced options add no independent contribution; unavailable ones can't be chosen at all.
			if (!option || !price || !isSelectable(option)) continue;
			const sub = option.description ?? undefined;
			switch (price.kind) {
				case 'FIXED':
					lines.push(line(currency, option.displayName, toUnits(price.amount), null, sub));
					break;
				case 'PER_QUANTITY':
					lines.push(line(currency, option.displayName, toUnits(price.amount), guests, sub));
					break;
				case 'PER_DURATION': {
					const flat = duration.offeringContributions.find((c) => c.offeringKey === key);
					if (flat) lines.push(line(currency, option.displayName, toUnits(flat.amount), null, sub));
					break;
				}
			}
		}
	}

	const toppings = preview.toppingAdjustment;
	const chosen = (
		inputs.selections.find((s) => s.category === toppings.category)?.offerings ?? []
	).filter((key) => {
		const option = findOffering(form, toppings.category, key);
		return option !== undefined && isSelectable(option);
	}).length;
	const extra = Math.max(0, chosen - toppings.includedSelections);
	if (extra > 0) {
		lines.push(
			line(
				currency,
				`${text(toppings.description) ?? 'Extra toppings'} (${extra})`,
				toUnits(toppings.additionalSelectionPerGuestAmount),
				guests * extra,
				text(toppings.subDescription) ??
					`${toppings.includedSelections} toppings included; each extra is charged per guest`
			)
		);
	}

	const total = lines.reduce((sum, l) => sum + l.subtotal, 0n);
	return {
		priceRevision: inputs.priceRevision,
		guestCountIsMinimum: inputs.guestCountIsMinimum === true,
		lines: lines.map((l) => l.line),
		subtotal: fromUnits(total),
		taxAmount: '0.00',
		total: fromUnits(total),
		currency
	};
}
