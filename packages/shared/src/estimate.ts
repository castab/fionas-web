import {
	draftPricingInputs,
	isSelectable,
	type EstimateLine,
	type EstimatePreview,
	type InquiryAnswers,
	type InquiryForm,
	type OfferingOption
} from './inquiry.ts';

/*
 * Advisory estimate computed in the browser from GET /inquiry-form's `pricingPreview`: the only
 * estimate the page shows. It follows the server's documented arithmetic but is display only, never
 * submitted or compared: POST /inquiries prices the submitted selections independently. Line
 * wording comes from `pricingPreview` when the backend supplies it, otherwise from the defaults here.
 */

// Amounts are exact decimals in strings; do the sums in scaled integers so nothing drifts.
const SCALE = 6;
const ONE = 10n ** BigInt(SCALE);

function toUnits(amount: string): bigint {
	const negative = amount.startsWith('-');
	const [whole = '0', fraction = ''] = amount.replace(/^[-+]/, '').split('.');
	const scaled = BigInt(whole || '0') * ONE + BigInt(fraction.padEnd(SCALE, '0').slice(0, SCALE));
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

/** Backend-supplied wording, or undefined when it is absent, null or blank. */
const text = (value: string | null | undefined): string | undefined => value?.trim() || undefined;

/** The duration question's own label for this choice (e.g. "1½ hours"), as the chips show it. */
function durationLabel(form: InquiryForm, minutes: number): string | undefined {
	for (const section of form.sections) {
		for (const field of section.fields) {
			if (
				field.submissionPointer === '/pricingInputs/durationMinutes' &&
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
	const inputs = draftPricingInputs(form, answers);
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
		catalogRevision: inputs.catalogRevision,
		guestCountIsMinimum: inputs.guestCountIsMinimum === true,
		lines: lines.map((l) => l.line),
		subtotal: fromUnits(total),
		taxAmount: '0.00',
		total: fromUnits(total),
		currency
	};
}
