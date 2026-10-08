import type { InquiryForm, OfferingOption } from '@fionas/shared';
import type {
	CurrentStaffRequest,
	DepositTermsRequest,
	InquiryRequestedPricing,
	PricingSelection
} from './request-contract.js';
import type {
	AdjustmentKind,
	InquiryQuotePreviewResponse,
	QuoteCompositionRequest,
	QuoteOverrideTarget,
	QuotePreviewLine,
	QuotePricingBasis
} from './quote-contract.js';
import { readDepositForm, depositInputError, type DepositFormValues } from './deposit.js';
import { moneyMinorUnits } from './payments.js';
import { formatMoney } from './presentation.js';

/* ---------------------------------------------------------------------------------------------
 * Catalog choices for the selection editor. Nothing here names an offering, price or limit: every
 * value comes from GET /offering-catalog (names, limits, availability) and GET /inquiry-form
 * (service durations and the guest minimum, found by submission pointer).
 * ------------------------------------------------------------------------------------------- */

export type CatalogCategory = {
	key: string;
	displayName: string;
	description?: string | null;
	minimumSelections: number;
	maximumSelections?: number | null;
	offerings: OfferingOption[];
};
export type OfferingsCatalog = {
	catalogId: string;
	revision: number;
	previousRevision?: number | null;
	categories: CatalogCategory[];
};
export type BuilderCategory = {
	key: string;
	label: string;
	minSelections: number;
	maxSelections: number | null;
	/** ENABLED offerings only; UNAVAILABLE ones stay listed but unselectable. */
	options: OfferingOption[];
};
export type BuilderChoices = {
	catalogRevision: number;
	guestMinimum: number;
	durations: { value: number; label: string }[];
	categories: BuilderCategory[];
};

export function builderChoices(catalog: unknown, form: unknown): BuilderChoices | null {
	if (!isCatalog(catalog) || !form || typeof form !== 'object') return null;
	const sections = (form as Partial<InquiryForm>).sections;
	if (!Array.isArray(sections)) return null;
	const fields = sections.flatMap((section) =>
		Array.isArray(section?.fields) ? section.fields : []
	);
	const guest = fields.find((field) => field?.submissionPointer === '/pricingInputs/guestCount');
	const duration = fields.find(
		(field) => field?.submissionPointer === '/pricingInputs/durationMinutes'
	);
	if (guest?.input?.type !== 'INTEGER' || duration?.input?.type !== 'INTEGER_CHOICE') return null;
	const durations = duration.input.options.filter(
		(option) => Number.isInteger(option?.value) && typeof option?.label === 'string'
	);
	if (!durations.length || !Number.isInteger(guest.input.minimum)) return null;
	return {
		catalogRevision: catalog.revision,
		guestMinimum: Math.max(1, guest.input.minimum),
		durations: durations.map(({ value, label }) => ({ value, label })),
		categories: catalog.categories.map((category) => ({
			key: category.key,
			label: category.displayName,
			minSelections: category.minimumSelections,
			maxSelections: category.maximumSelections ?? null,
			options: category.offerings.filter((option) => option.selectionState === 'ENABLED')
		}))
	};
}

function isCatalog(value: unknown): value is OfferingsCatalog {
	if (!value || typeof value !== 'object') return false;
	const catalog = value as Partial<OfferingsCatalog>;
	return (
		Number.isInteger(catalog.revision) &&
		(catalog.revision as number) > 0 &&
		Array.isArray(catalog.categories) &&
		catalog.categories.every(
			(category) =>
				typeof category?.key === 'string' &&
				typeof category.displayName === 'string' &&
				Number.isInteger(category.minimumSelections) &&
				Array.isArray(category.offerings) &&
				category.offerings.every(
					(offering) =>
						typeof offering?.key === 'string' &&
						typeof offering.displayName === 'string' &&
						['ENABLED', 'DISABLED'].includes(offering.selectionState) &&
						['AVAILABLE', 'UNAVAILABLE'].includes(offering.availability)
				)
		)
	);
}

/* ---------------------------------------------------------------------------------------------
 * Override targets. A preview line's provenance names what an override may target; a key encodes
 * that target in a form field name.
 * ------------------------------------------------------------------------------------------- */

export function lineTarget(line: QuotePreviewLine): QuoteOverrideTarget | null {
	if (line.origin.type === 'ESTIMATE_LINE')
		return line.lineItemId ? { type: 'EXISTING_LINE', lineItemId: line.lineItemId } : null;
	if (line.origin.type === 'GENERATED') return line.origin.source;
	return null;
}

export function targetKey(target: QuoteOverrideTarget): string {
	if (target.type === 'EXISTING_LINE') return `EXISTING_LINE:${target.lineItemId}`;
	if (target.type === 'SELECTED_OFFERING')
		return `SELECTED_OFFERING:${encodeURIComponent(target.category)}:${encodeURIComponent(target.offering)}`;
	return target.type;
}

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export function parseTargetKey(key: string): QuoteOverrideTarget | null {
	if (key === 'BASE_SERVICE' || key === 'ICE_CREAM_SERVICE' || key === 'EXTRA_TOPPINGS')
		return { type: key };
	const existing = /^EXISTING_LINE:(.+)$/.exec(key);
	if (existing)
		return UUID.test(existing[1]) ? { type: 'EXISTING_LINE', lineItemId: existing[1] } : null;
	const offering = /^SELECTED_OFFERING:([^:]+):([^:]+)$/.exec(key);
	if (!offering) return null;
	try {
		const category = decodeURIComponent(offering[1]);
		const key = decodeURIComponent(offering[2]);
		return category && key ? { type: 'SELECTED_OFFERING', category, offering: key } : null;
	} catch {
		return null;
	}
}

/* ---------------------------------------------------------------------------------------------
 * The posted builder form. Every value stays an exact string so a failed POST can re-render it.
 * ------------------------------------------------------------------------------------------- */

export const adjustmentKinds = ['CHARGE', 'DISCOUNT', 'CREDIT'] as const;
export function adjustmentKindLabel(kind: AdjustmentKind): string {
	return kind === 'CHARGE' ? 'Charge' : kind === 'DISCOUNT' ? 'Discount' : 'Credit';
}
export const quoteBasisValues = [
	'KEEP_ESTIMATE',
	'REVISE_SERVICE_SELECTIONS',
	'REPRICE_CONFIGURATION'
] as const;

export type ServiceDraft = {
	catalogRevision: string;
	guestCount: string;
	guestCountIsMinimum: boolean;
	durationMinutes: string;
	/** One entry per catalog category, in presentation order; offerings in display order. */
	selections: PricingSelection[];
};
export type OverrideDraft = { key: string; amount: string; original: string; reason: string };
export type AdjustmentDraft = {
	clientKey: string;
	kind: AdjustmentKind;
	description: string;
	detail: string;
	amount: string;
	reason: string;
};
export type QuoteFormValues = {
	deposit: DepositFormValues;
	service: ServiceDraft | null;
	overrides: OverrideDraft[];
	adjustments: AdjustmentDraft[];
	reviewToken: string;
	reviewedBasis: QuotePricingBasis | '';
	reviewedFingerprint: string;
	/** The reviewed Estimate's currency, posted so a preview needs no projection read. */
	reviewedCurrency: string;
	/** What the reviewed Estimate was priced from; absent when the service isn't editable. */
	reviewedConfiguration: InquiryRequestedPricing | null;
};

const DEPOSIT_FIELDS = [
	'expectedVersion',
	'depositChoice',
	'reviewedSuggestionType',
	'reviewedSuggestionValue',
	'depositPercentage',
	'depositAmount'
];
const SINGLE_FIELDS = [
	'service',
	'catalogRevision',
	'guestCount',
	'guestCountIsMinimum',
	'durationMinutes',
	'reviewToken',
	'reviewedBasis',
	'reviewedFingerprint',
	'reviewedCurrency',
	'reviewedConfiguration'
];
const CLIENT_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TEXT = 600;
/** A whole configuration (every category's picks) as JSON. */
const MAX_CONFIGURATION = 8000;

/** Strict UI envelope: unknown, duplicate or file fields reject the whole post. */
export function readQuoteForm(form: FormData): QuoteFormValues | null {
	const deposit = new FormData();
	const seen = new Set<string>();
	for (const [key, value] of form.entries()) {
		if (
			typeof value !== 'string' ||
			value.length > (key === 'reviewedConfiguration' ? MAX_CONFIGURATION : MAX_TEXT)
		)
			return null;
		if (DEPOSIT_FIELDS.includes(key)) {
			deposit.append(key, value);
			continue;
		}
		const repeated = key === 'category' || key === 'adjustment' || key.startsWith('pick:');
		if (!repeated) {
			if (seen.has(key)) return null;
			seen.add(key);
		}
		if (
			!repeated &&
			!SINGLE_FIELDS.includes(key) &&
			!/^override:(amount|original|reason):.+$/.test(key) &&
			!/^adjustment:(kind|description|detail|amount|reason):[A-Za-z0-9_-]{1,64}$/.test(key)
		)
			return null;
	}
	const depositValues = readDepositForm(deposit);
	if (!depositValues) return null;
	const text = (key: string) => (form.get(key) as string | null) ?? '';

	let service: ServiceDraft | null = null;
	if (form.has('service')) {
		const categories = form.getAll('category') as string[];
		if (!categories.length || new Set(categories).size !== categories.length) return null;
		const pickCategories = [...form.keys()]
			.filter((key) => key.startsWith('pick:'))
			.map((key) => key.slice(5));
		if (pickCategories.some((category) => !categories.includes(category))) return null;
		const selections = categories.map((category) => ({
			category,
			offerings: form.getAll(`pick:${category}`) as string[]
		}));
		if (
			selections.some(
				({ offerings }) => offerings.some((o) => !o) || new Set(offerings).size !== offerings.length
			)
		)
			return null;
		if (!/^[1-9]\d{0,9}$/.test(text('catalogRevision'))) return null;
		if (!['', 'on'].includes(text('guestCountIsMinimum'))) return null;
		service = {
			catalogRevision: text('catalogRevision'),
			guestCount: text('guestCount').trim(),
			guestCountIsMinimum: text('guestCountIsMinimum') === 'on',
			durationMinutes: text('durationMinutes'),
			selections
		};
	} else if (
		['category', 'catalogRevision', 'guestCount', 'guestCountIsMinimum', 'durationMinutes'].some(
			(key) => form.has(key)
		) ||
		[...form.keys()].some((key) => key.startsWith('pick:'))
	)
		return null;

	const overrideKeys = [
		...new Set(
			[...form.keys()]
				.filter((key) => key.startsWith('override:'))
				.map((key) => key.replace(/^override:(amount|original|reason):/, ''))
		)
	];
	const overrides: OverrideDraft[] = [];
	for (const key of overrideKeys) {
		if (!parseTargetKey(key) || !form.has(`override:amount:${key}`)) return null;
		if (!form.has(`override:original:${key}`)) return null;
		overrides.push({
			key,
			amount: text(`override:amount:${key}`).trim(),
			original: text(`override:original:${key}`),
			reason: text(`override:reason:${key}`)
		});
	}

	const clientKeys = form.getAll('adjustment') as string[];
	if (
		clientKeys.some((key) => !CLIENT_KEY.test(key)) ||
		new Set(clientKeys).size !== clientKeys.length
	)
		return null;
	const adjustmentFieldKeys = new Set(
		[...form.keys()].filter((key) => key.startsWith('adjustment:')).map((key) => key.split(':')[2])
	);
	if ([...adjustmentFieldKeys].some((key) => !clientKeys.includes(key))) return null;
	const adjustments: AdjustmentDraft[] = [];
	for (const clientKey of clientKeys) {
		const kind = text(`adjustment:kind:${clientKey}`) as AdjustmentKind;
		if (!adjustmentKinds.includes(kind)) return null;
		adjustments.push({
			clientKey,
			kind,
			description: text(`adjustment:description:${clientKey}`),
			detail: text(`adjustment:detail:${clientKey}`),
			amount: text(`adjustment:amount:${clientKey}`).trim(),
			reason: text(`adjustment:reason:${clientKey}`)
		});
	}

	const reviewToken = text('reviewToken');
	const reviewedBasis = text('reviewedBasis') as QuotePricingBasis | '';
	if (reviewToken && !/^[0-9a-f]{64}$/.test(reviewToken)) return null;
	if (reviewedBasis && !quoteBasisValues.includes(reviewedBasis)) return null;
	const reviewedFingerprint = text('reviewedFingerprint');
	if (reviewedFingerprint && !/^[0-9a-f]{64}$/.test(reviewedFingerprint)) return null;
	const reviewedCurrency = text('reviewedCurrency');
	if (reviewedCurrency && !/^[A-Z]{3}$/.test(reviewedCurrency)) return null;
	let reviewedConfiguration: InquiryRequestedPricing | null = null;
	if (form.has('reviewedConfiguration')) {
		reviewedConfiguration = parseConfiguration(text('reviewedConfiguration'));
		if (!reviewedConfiguration) return null;
	}
	return {
		deposit: depositValues,
		service,
		overrides,
		adjustments,
		reviewToken,
		reviewedBasis,
		reviewedFingerprint,
		reviewedCurrency,
		reviewedConfiguration
	};
}

function parseConfiguration(json: string): InquiryRequestedPricing | null {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return null;
	}
	if (!value || typeof value !== 'object') return null;
	const config = value as InquiryRequestedPricing;
	const count = (n: unknown) => Number.isInteger(n) && (n as number) > 0;
	return count(config.catalogRevision) &&
		count(config.guestCount) &&
		count(config.durationMinutes) &&
		typeof config.guestCountIsMinimum === 'boolean' &&
		Array.isArray(config.selections) &&
		config.selections.every(
			(s) =>
				typeof s?.category === 'string' &&
				Array.isArray(s.offerings) &&
				s.offerings.every((o) => typeof o === 'string')
		)
		? {
				catalogRevision: config.catalogRevision,
				guestCount: config.guestCount,
				guestCountIsMinimum: config.guestCountIsMinimum,
				durationMinutes: config.durationMinutes,
				selections: config.selections.map(({ category, offerings }) => ({
					category,
					offerings: [...offerings]
				}))
			}
		: null;
}

/**
 * Deposit terms exactly as staff reviewed them. The suggestion comes from the reviewed snapshot;
 * issuance compares it with the authoritative projection before anything is written.
 */
export function reviewedTerms(deposit: DepositFormValues, currency: string): DepositTermsRequest {
	if (deposit.depositChoice === 'percentage')
		return { type: 'PERCENTAGE', percentage: deposit.depositPercentage };
	if (deposit.depositChoice === 'fixed')
		return { type: 'FIXED', amount: deposit.depositAmount, currency };
	return deposit.reviewedSuggestionType === 'PERCENTAGE'
		? { type: 'PERCENTAGE', percentage: deposit.reviewedSuggestionValue }
		: { type: 'FIXED', amount: deposit.reviewedSuggestionValue, currency };
}

/** A native form always carries one blank added line; untouched blank rows are not intent. */
export function isBlankAdjustment(adjustment: AdjustmentDraft): boolean {
	return [adjustment.description, adjustment.detail, adjustment.amount, adjustment.reason].every(
		(value) => !value.trim()
	);
}

/** An override is intent only when its amount differs from the line's original amount. */
export function isActiveOverride(override: OverrideDraft, currency: string): boolean {
	const amount = moneyMinorUnits(override.amount, currency);
	const original = moneyMinorUnits(override.original, currency);
	return amount === null || original === null || amount !== original;
}

export type QuoteFieldErrors = Record<string, string>;
export type QuoteNotices = {
	repriced?: boolean;
	overridesCleared?: boolean;
	reviewStale?: boolean;
};
/** What the preview and issue actions return: a reviewed preview, or why there isn't one. */
export type QuoteActionResult = {
	preview?: InquiryQuotePreviewResponse;
	quoteValues?: QuoteFormValues;
	notices?: QuoteNotices;
	quoteError?: string;
	reviewRequired?: boolean;
	fieldErrors?: QuoteFieldErrors;
	feedback?: Partial<Record<FeedbackSection, string[]>>;
	catalogStale?: boolean;
};

/** Local UX checks only; Commerce validates every value again. Keys are form field names. */
export function quoteInputErrors(values: QuoteFormValues, currency: string): QuoteFieldErrors {
	const errors: QuoteFieldErrors = {};
	const depositError = depositInputError(values.deposit);
	if (depositError)
		errors[depositError] =
			depositError === 'depositPercentage'
				? 'Enter a percentage greater than 0, up to 100.'
				: 'Enter a deposit amount greater than $0.';
	if (values.service) {
		if (!/^[1-9]\d{0,5}$/.test(values.service.guestCount))
			errors.guestCount = 'Enter a whole number of guests.';
		if (!/^[1-9]\d{0,4}$/.test(values.service.durationMinutes))
			errors.durationMinutes = 'Choose a scooping time.';
	}
	for (const override of values.overrides) {
		if (!isActiveOverride(override, currency)) continue;
		if (moneyMinorUnits(override.amount, currency) === null)
			errors[`override:amount:${override.key}`] =
				'Enter an amount of $0 or more, in cents at most.';
		if (!override.reason.trim() || override.reason.length > 500)
			errors[`override:reason:${override.key}`] = 'Say why this price changed.';
	}
	for (const adjustment of values.adjustments) {
		if (isBlankAdjustment(adjustment)) continue;
		const key = adjustment.clientKey;
		const description = adjustment.description.trim();
		if (!description || description.length > 120)
			errors[`adjustment:description:${key}`] = 'Name this line (up to 120 characters).';
		if (adjustment.detail.length > 240)
			errors[`adjustment:detail:${key}`] = 'Keep the detail under 240 characters.';
		const amount = moneyMinorUnits(adjustment.amount, currency);
		if (amount === null || amount <= 0n)
			errors[`adjustment:amount:${key}`] = 'Enter an amount greater than $0.';
		if (!adjustment.reason.trim() || adjustment.reason.length > 500)
			errors[`adjustment:reason:${key}`] = 'Say why this line is added.';
	}
	return errors;
}

/* ---------------------------------------------------------------------------------------------
 * Pricing mode and composition. The backend owns every amount: these helpers only name intent.
 * ------------------------------------------------------------------------------------------- */

/** The configuration the reviewed Estimate was priced from, or null when it cannot be known. */
export function effectiveConfiguration(data: CurrentStaffRequest): InquiryRequestedPricing | null {
	return (
		data.financial.pricing ?? (data.financial.version === 1 ? data.inquiry.pricingInputs : null)
	);
}

function selectionSets(selections: PricingSelection[]): Map<string, string> {
	return new Map(
		selections
			.filter(({ offerings }) => offerings.length)
			.map(({ category, offerings }) => [category, [...offerings].sort().join('\u0000')])
	);
}
export function sameSelections(a: PricingSelection[], b: PricingSelection[]): boolean {
	const left = selectionSets(a);
	const right = selectionSets(b);
	return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

/** The mode the service edits call for; REVISE may still need repricing, which only Commerce knows. */
export function chooseBasis(
	service: ServiceDraft | null,
	effective: InquiryRequestedPricing | null
): QuotePricingBasis {
	if (!service || !effective) return 'KEEP_ESTIMATE';
	if (
		Number(service.guestCount) !== effective.guestCount ||
		service.guestCountIsMinimum !== effective.guestCountIsMinimum ||
		Number(service.durationMinutes) !== effective.durationMinutes
	)
		return 'REPRICE_CONFIGURATION';
	return sameSelections(service.selections, effective.selections)
		? 'KEEP_ESTIMATE'
		: 'REVISE_SERVICE_SELECTIONS';
}

/** Whether a previewed basis still describes the current edits (REVISE may have been repriced). */
export function basisStillReviewed(reviewed: QuotePricingBasis | '', current: QuotePricingBasis) {
	return (
		reviewed === current ||
		(reviewed === 'REPRICE_CONFIGURATION' && current === 'REVISE_SERVICE_SELECTIONS')
	);
}

export function buildComposition(
	values: QuoteFormValues,
	basis: QuotePricingBasis,
	currency: string
): { composition: QuoteCompositionRequest; clearedOverrides: boolean } {
	const service = values.service;
	const selections = (service?.selections ?? []).map(({ category, offerings }) => ({
		category,
		offerings: [...offerings]
	}));
	const pricing: QuoteCompositionRequest['pricing'] =
		basis === 'KEEP_ESTIMATE' || !service
			? { mode: 'KEEP_ESTIMATE' }
			: basis === 'REVISE_SERVICE_SELECTIONS'
				? {
						mode: 'REVISE_SERVICE_SELECTIONS',
						catalogRevision: Number(service.catalogRevision),
						selections
					}
				: {
						mode: 'REPRICE_CONFIGURATION',
						catalogRevision: Number(service.catalogRevision),
						guestCount: Number(service.guestCount),
						guestCountIsMinimum: service.guestCountIsMinimum,
						durationMinutes: Number(service.durationMinutes),
						selections
					};
	const repricing = pricing.mode === 'REPRICE_CONFIGURATION';
	const selected = new Set(
		selections.flatMap((s) => s.offerings.map((o) => `${s.category}\u0000${o}`))
	);
	let clearedOverrides = false;
	const overrides = values.overrides
		.filter((override) => isActiveOverride(override, currency))
		.flatMap((override) => {
			const target = parseTargetKey(override.key)!;
			const fits = repricing
				? target.type !== 'EXISTING_LINE' &&
					(target.type !== 'SELECTED_OFFERING' ||
						selected.has(`${target.category}\u0000${target.offering}`))
				: target.type === 'EXISTING_LINE';
			if (!fits) {
				clearedOverrides = true;
				return [];
			}
			return [{ target, finalAmount: override.amount, currency, reason: override.reason.trim() }];
		});
	const adjustments = values.adjustments
		.filter((adjustment) => !isBlankAdjustment(adjustment))
		.map((adjustment) => ({
			clientKey: adjustment.clientKey,
			kind: adjustment.kind,
			description: adjustment.description.trim(),
			...(adjustment.detail.trim() && { subDescription: adjustment.detail.trim() }),
			amount: adjustment.amount,
			currency,
			reason: adjustment.reason.trim()
		}));
	return {
		composition: {
			pricing,
			...(overrides.length && { overrides }),
			...(adjustments.length && { adjustments })
		},
		clearedOverrides
	};
}

/* ---------------------------------------------------------------------------------------------
 * Preview response checks and presentation.
 * ------------------------------------------------------------------------------------------- */

const SIGNED_DECIMAL = /^-?\d+(?:\.\d+)?$/;
const DECIMAL = /^\d+(?:\.\d+)?$/;

/** Validate the preview fields the builder renders and posts back; anything else is unavailable. */
export function isQuotePreview(
	value: unknown,
	expected: { inquiryId: string; currency: string; documentId?: string }
): value is InquiryQuotePreviewResponse {
	if (!value || typeof value !== 'object') return false;
	const preview = value as InquiryQuotePreviewResponse;
	const currency = expected.currency;
	return (
		preview.inquiryId === expected.inquiryId &&
		typeof preview.documentId === 'string' &&
		(expected.documentId === undefined || preview.documentId === expected.documentId) &&
		Number.isInteger(preview.reviewedDocumentVersion) &&
		Number.isInteger(preview.quoteVersion) &&
		Number.isInteger(preview.catalogRevision) &&
		quoteBasisValues.includes(preview.pricingBasis as QuotePricingBasis) &&
		typeof preview.financialChange === 'boolean' &&
		typeof preview.reviewToken === 'string' &&
		/^[0-9a-f]{64}$/.test(preview.reviewToken) &&
		preview.currency === currency &&
		[preview.subtotal, preview.taxAmount, preview.total].every(
			(amount) => typeof amount === 'string' && SIGNED_DECIMAL.test(amount)
		) &&
		typeof preview.estimateTotal === 'string' &&
		DECIMAL.test(preview.estimateTotal) &&
		!!preview.deposit?.requiredAmount &&
		typeof preview.deposit.requiredAmount.amount === 'string' &&
		DECIMAL.test(preview.deposit.requiredAmount.amount) &&
		preview.deposit.requiredAmount.currency === currency &&
		!!preview.service &&
		Number.isInteger(preview.service.guestCount) &&
		Number.isInteger(preview.service.durationMinutes) &&
		Array.isArray(preview.service.selections) &&
		preview.service.selections.every(
			(category) =>
				typeof category?.category === 'string' &&
				typeof category.displayName === 'string' &&
				Array.isArray(category.offerings) &&
				category.offerings.every(
					(offering) =>
						typeof offering?.offering === 'string' && typeof offering.displayName === 'string'
				)
		) &&
		Array.isArray(preview.lines) &&
		preview.lines.every(
			(line) =>
				typeof line?.description === 'string' &&
				line.currency === currency &&
				typeof line.total === 'string' &&
				SIGNED_DECIMAL.test(line.total) &&
				typeof line.unitPrice === 'string' &&
				SIGNED_DECIMAL.test(line.unitPrice) &&
				(line.lineItemId === undefined || UUID.test(line.lineItemId)) &&
				isOrigin(line.origin) &&
				(line.override === undefined ||
					(typeof line.override?.reason === 'string' &&
						typeof line.override.originalTotal === 'string' &&
						DECIMAL.test(line.override.originalTotal)))
		)
	);
}

function isOrigin(origin: unknown): boolean {
	if (!origin || typeof origin !== 'object') return false;
	const value = origin as { type?: unknown; source?: { type?: unknown }; kind?: unknown };
	if (value.type === 'ESTIMATE_LINE') return true;
	if (value.type === 'ADJUSTMENT') return adjustmentKinds.includes(value.kind as AdjustmentKind);
	return (
		value.type === 'GENERATED' &&
		['BASE_SERVICE', 'ICE_CREAM_SERVICE', 'EXTRA_TOPPINGS', 'SELECTED_OFFERING'].includes(
			value.source?.type as string
		)
	);
}

export function basisNotice(basis: string): { tone: 'calm' | 'strong'; text: string } {
	if (basis === 'REPRICE_CONFIGURATION')
		return {
			tone: 'strong',
			text: 'The whole price is recalculated from today’s catalog, not their original estimate.'
		};
	if (basis === 'REVISE_SERVICE_SELECTIONS')
		return { tone: 'calm', text: 'Service changes only — their estimate’s prices stay the same.' };
	return { tone: 'calm', text: 'Starts from their estimate’s lines and prices.' };
}

/** "Was $160.00 · 40 × $4.00" for an overridden line. */
export function overrideOriginalLabel(line: QuotePreviewLine): string | null {
	if (!line.override) return null;
	const original = formatMoney(line.override.originalTotal, line.currency);
	return line.override.originalQuantity !== undefined
		? `Was ${original} · ${line.override.originalQuantity} × ${formatMoney(line.override.originalUnitPrice, line.currency)}`
		: `Was ${original}`;
}

export type FeedbackSection = 'service' | 'lines' | 'adjustments' | 'total' | 'form';
const violationFeedback: Record<string, [FeedbackSection, string]> = {
	QUOTE_TOTAL_NOT_POSITIVE: [
		'total',
		'The quote total must be more than $0, and the deposit can’t be more than the total.'
	],
	NEGATIVE_DOCUMENT_TOTAL: ['total', 'Discounts and credits can’t take the total below $0.'],
	OVERRIDE_UNCHANGED: [
		'lines',
		'A changed line amount matches its original price. Restore that line instead.'
	],
	OVERRIDE_TARGET_NOT_ALLOWED: [
		'lines',
		'A line you changed doesn’t exist in this pricing. Review the lines and try again.'
	],
	OVERRIDE_TARGET_NOT_FOUND: [
		'lines',
		'A line you changed doesn’t exist in this pricing. Review the lines and try again.'
	],
	DUPLICATE_OVERRIDE_TARGET: ['lines', 'Each line’s price can only be changed once.'],
	DUPLICATE_ADJUSTMENT_KEY: ['adjustments', 'Two added lines clash. Remove one and add it again.'],
	UNKNOWN_OFFERING: ['service', 'A pick is no longer on the menu. Remove it and choose again.'],
	OFFERING_DISABLED: ['service', 'A pick is no longer on the menu. Remove it and choose again.'],
	OFFERING_UNAVAILABLE: ['service', 'A pick is unavailable right now. Choose another.'],
	TOO_MANY_SELECTIONS: ['service', 'One list has more picks than it allows.'],
	TOO_FEW_SELECTIONS: ['service', 'One list needs more picks.'],
	INVALID_GUEST_COUNT: ['service', 'That guest count can’t be priced. Try a different number.'],
	UNSUPPORTED_DURATION: ['service', 'That scooping time can’t be priced. Pick a listed option.'],
	INCOMPATIBLE_DURATION_PRICE: [
		'service',
		'A pick can’t be priced for that scooping time. Change one of them.'
	],
	SERVICE_SELECTIONS_UNCHANGED: ['service', 'These picks already match their estimate.'],
	SERVICE_SELECTIONS_CHANGE_PRICING: ['service', 'These pick changes affect the price.'],
	CURRENCY_MISMATCH: [
		'form',
		'This quote’s currency doesn’t match the estimate. Reload to review.'
	],
	UNSUPPORTED_CURRENCY: [
		'form',
		'This quote’s currency doesn’t match the estimate. Reload to review.'
	]
};
/** Staff copy for stable violation codes, grouped by builder section. Backend text never shows. */
export function quoteViolationFeedback(
	codes: string[]
): Partial<Record<FeedbackSection, string[]>> {
	const out: Partial<Record<FeedbackSection, string[]>> = {};
	const all = codes.length ? codes : ['UNKNOWN'];
	for (const code of all) {
		const [section, text] = violationFeedback[code] ?? [
			'form',
			'Some of these quote details couldn’t be accepted. Review them and try again.'
		];
		if (!(out[section] ??= []).includes(text)) out[section].push(text);
	}
	return out;
}

/** "Changed from their estimate — added Horchata · removed Vanilla." */
export function picksDiff(
	selections: PricingSelection[],
	base: PricingSelection[],
	name: (category: string, offering: string) => string
): string {
	const keyed = (list: PricingSelection[]) =>
		new Set(list.flatMap((s) => s.offerings.map((o) => `${s.category}\u0000${o}`)));
	const now = keyed(selections);
	const before = keyed(base);
	const label = (key: string) => {
		const [category, offering] = key.split('\u0000');
		return name(category, offering);
	};
	const added = [...now].filter((key) => !before.has(key)).map(label);
	const removed = [...before].filter((key) => !now.has(key)).map(label);
	if (!added.length && !removed.length) return '';
	const parts = [
		...(added.length ? [`added ${added.join(', ')}`] : []),
		...(removed.length ? [`removed ${removed.join(', ')}`] : [])
	];
	return `Changed from their estimate — ${parts.join(' · ')}.`;
}
