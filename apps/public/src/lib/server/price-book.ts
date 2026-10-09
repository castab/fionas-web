import { readFileSync } from 'node:fs';
import { env } from '$env/dynamic/private';
import {
	computeAdvisoryEstimate,
	type InquiryForm,
	type InquiryIntent,
	type PricedInquiry
} from '@fionas/shared';
import { MENU_SECTIONS, PRICE_KEYS } from './menu.js';

export type PriceBook = Readonly<{ revision: string; amounts: Readonly<Record<string, string>> }>;
/** Deliberately restricted YAML: two mappings, quoted scalar values, no aliases/tags/merges. */
export function parsePriceBook(source: string): PriceBook {
	if (source.length > 32_768) throw new Error('Price book too large');
	let revision: string | undefined;
	let inAmounts = false;
	const amounts: Record<string, string> = Object.create(null);
	for (const line of source.split(/\r?\n/)) {
		if (!line.trim() || line.trimStart().startsWith('#')) continue;
		if (line === 'amounts:') {
			if (inAmounts) throw new Error('Duplicate amounts');
			inAmounts = true;
			continue;
		}
		const rev = /^revision: (?:'([^'\r\n]+)'|"([^"\\\r\n]+)")$/.exec(line);
		if (rev) {
			if (revision || inAmounts) throw new Error('Duplicate or misplaced revision');
			revision = rev[1] ?? rev[2];
			if (!revision.trim() || revision.length > 160) throw new Error('Invalid revision');
			continue;
		}
		const entry = /^ {2}([a-z0-9_.-]+): (?:'([0-9]+(?:\.[0-9]+)?)'|"([0-9]+(?:\.[0-9]+)?)")$/.exec(
			line
		);
		if (!inAmounts || !entry) throw new Error('Unsupported price book schema');
		const key = entry[1];
		const amount = entry[2] ?? entry[3];
		if (!PRICE_KEYS.includes(key) || Object.hasOwn(amounts, key))
			throw new Error('Unknown or duplicate price key');
		if (!/^[0-9]{1,9}(\.[0-9]{1,12})?$/.test(amount)) throw new Error('Invalid price precision');
		const [whole, fraction = ''] = amount.split('.');
		const units = BigInt(whole) * 10n ** 12n + BigInt(fraction.padEnd(12, '0'));
		// Any integer guest count is offered, so every amount must settle to whole cents.
		if (units % 10_000_000_000n !== 0n) throw new Error('Nonsettleable public price');
		amounts[key] = amount;
	}
	if (!revision || !inAmounts || PRICE_KEYS.some((key) => !Object.hasOwn(amounts, key)))
		throw new Error('Incomplete price book');
	return Object.freeze({ revision, amounts: Object.freeze(amounts) });
}

let cached: PriceBook | null = null;
export function getPriceBook(): PriceBook {
	if (cached) return cached;
	if (!env.FIONAS_PRICES_FILE) throw new Error('Prices unavailable');
	cached = parsePriceBook(readFileSync(env.FIONAS_PRICES_FILE, 'utf8'));
	return cached;
}

function cents(amount: string): bigint {
	const [whole, fraction = ''] = amount.split('.');
	if (/[1-9]/.test(fraction.substring(2))) throw new Error('Nonsettleable price');
	return BigInt(whole) * 100n + BigInt(fraction.substring(0, 2).padEnd(2, '0'));
}

/** Selective public presentation, no file path, private keys or whole price document. */
export function projectForm(book: PriceBook): InquiryForm {
	const sections = structuredClone(MENU_SECTIONS);
	for (const section of sections)
		for (const field of section.fields) {
			if (field.input.type !== 'OFFERING_CHOICE') continue;
			for (const option of field.input.options) {
				const amount = book.amounts[option.priceKey!];
				if (cents(amount) !== 0n)
					option.price = { kind: 'PER_QUANTITY', amount, currency: 'USD', dimension: 'guest' };
				delete option.priceKey;
				delete option.pricingKind;
			}
		}
	return {
		definitionVersion: 11,
		priceRevision: book.revision,
		sections,
		pricingPreview: {
			currency: 'USD',
			guestQuantityDimension: 'guest',
			baseServiceAmount: book.amounts['event.base'],
			perGuestAmount: book.amounts['event.per_guest'],
			toppingAdjustment: {
				category: 'topping',
				includedSelections: 4,
				additionalSelectionPerGuestAmount: book.amounts['topping.extra_per_guest']
			}
		}
	};
}
/** Staff read the group without the customer's pick instruction: "Toppings — pick 4 to 6" → "Toppings". */
const groupName = (label: string) => label.replace(/ — pick .*$/, '');

export function priceInquiry(intent: InquiryIntent, book: PriceBook): PricedInquiry {
	const form = projectForm(book);
	const { serviceInputs, ...contact } = intent;
	// Price the validated intent itself; raw browser answers never become financial input here.
	const values = Object.fromEntries(
		form.sections.flatMap((section) =>
			section.fields
				.filter((field) => field.submissionPointer.startsWith('/serviceInputs/'))
				.map((field) => {
					const property = field.submissionPointer.substring(
						'/serviceInputs/'.length
					) as keyof typeof serviceInputs;
					return [
						field.key,
						field.input.type === 'OFFERING_CHOICE'
							? (serviceInputs.selections.find(
									(s) => s.category === (field.input as { category: string }).category
								)?.offerings ?? [])
							: field.input.type === 'BOOLEAN'
								? serviceInputs[property] === true
								: String(serviceInputs[property])
					];
				})
		)
	);
	const answers = { values };
	const estimate = computeAdvisoryEstimate(form, answers);
	if (!estimate) throw new Error('Incomplete service');
	const items = form.sections.flatMap((s) =>
		s.fields.flatMap((f) =>
			f.input.type === 'OFFERING_CHOICE'
				? f.input.options
						.filter((o) =>
							serviceInputs.selections.some(
								(s) => s.category === o.category && s.offerings.includes(o.key)
							)
						)
						.map((o) => ({ label: o.displayName, group: groupName(f.label), key: o.key }))
				: []
		)
	);
	return {
		...contact,
		requestedService: {
			guestCount: serviceInputs.guestCount,
			guestCountIsMinimum: serviceInputs.guestCountIsMinimum,
			items,
			pricingReference: `web-menu-1:${book.revision}`
		},
		lines: estimate.lines.map(
			({ description, subDescription, quantity, unitPrice, taxAmount, currency }) => ({
				description,
				...(subDescription ? { subDescription } : {}),
				...(quantity ? { quantity } : {}),
				unitPrice,
				taxAmount,
				currency
			})
		)
	};
}
