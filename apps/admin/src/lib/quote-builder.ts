import {
	GROUP_MAX,
	KEY_MAX,
	LABEL_MAX,
	MAX_SELECTIONS,
	canonicalSelection,
	isPlaceholder,
	isServicePlanItem,
	isServicePlanItems,
	selectionDrafts,
	type SelectionDraft
} from './service-selections.js';
import {
	readDepositForm,
	depositInputError,
	isDepositTerms,
	matchesReviewedSuggestion,
	suggestionValue,
	type DepositFormValues
} from './deposit.js';
import { CENT_DIGITS, CURRENCY, isSupportedCurrency } from './currency.js';
import type { CurrentStaffRequest, DepositTermsRequest } from './request-contract.js';
import type {
	QuoteCommand,
	ProposedLine,
	InquiryQuotePreviewResponse,
	InvoiceRevisionPreviewResponse,
	QuoteRevisionPreviewResponse,
	RevisionCommand,
	ServicePlanItem
} from './quote-contract.js';
import { serviceCommitment } from './service-plan.js';
import { isEditorMode, type FinancialEditorMode } from './financial-editor.js';

export type { SelectionDraft };
export type LineDraft = ProposedLine & { note: string };
export type QuoteFormValues = {
	mode: FinancialEditorMode;
	/** The financial document version staff reviewed. Every mode binds to it. */
	expectedVersion: string;
	/** Initial Quote and Quote revision only; an Invoice amendment never edits or posts terms. */
	deposit: DepositFormValues | null;
	/** Quote revision only: the deposit revision and publication that were reviewed. */
	expectedDepositRevision: string;
	expectedProposalId: string;
	/** The effective service approval's revision when the editor opened; '' when none existed. */
	expectedPlanRevision: string;
	/** The deliberate "remove the service plan" choice. Never inferred from a blank description. */
	clearPlan: boolean;
	lines: LineDraft[];
	description: string;
	guestCount: string;
	items: SelectionDraft[];
	/** The reviewed document's currency, echoed by the page. Only USD is accepted. */
	reviewedCurrency: typeof CURRENCY;
	reviewToken: string;
	reviewedFingerprint: string;
};
/** The backend's review of exactly one editor mode; what is shown is never mixed across modes. */
export type EditorPreview =
	| { mode: 'INITIAL_QUOTE'; quote: InquiryQuotePreviewResponse }
	| { mode: 'QUOTE_REVISION'; revision: QuoteRevisionPreviewResponse }
	| { mode: 'INVOICE_AMENDMENT'; invoice: InvoiceRevisionPreviewResponse };
export type QuoteActionResult = {
	quoteValues?: QuoteFormValues;
	preview?: EditorPreview;
	quoteError?: string;
	reviewRequired?: boolean;
	fieldErrors?: Record<string, string>;
	notices?: { reviewStale?: boolean; noChange?: boolean };
};
export function initialQuoteValues(data: CurrentStaffRequest): QuoteFormValues {
	const service = data.inquiry.requestedService;
	const terms = data.suggestedDepositTerms;
	return {
		mode: 'INITIAL_QUOTE',
		expectedVersion: String(data.financial.version),
		expectedDepositRevision: '',
		expectedProposalId: '',
		expectedPlanRevision: '',
		clearPlan: false,
		deposit: {
			expectedVersion: String(data.financial.version),
			depositChoice: 'suggested',
			reviewedSuggestionType: terms.type,
			reviewedSuggestionValue: terms.type === 'PERCENTAGE' ? terms.percentage : terms.amount,
			depositPercentage: '',
			depositAmount: ''
		},
		lines: data.financial.lines.map((l) => ({
			lineItemId: l.id,
			description: l.description,
			subDescription: l.subDescription,
			quantity: l.quantity,
			unitPrice: l.unitPrice,
			taxAmount: l.taxAmount,
			currency: l.currency,
			note: ''
		})),
		description: 'Ice cream service',
		guestCount: String(service.guestCount),
		// An independent draft of the customer's picks, in their order, with categories and keys.
		items: selectionDrafts(service.items),
		reviewedCurrency: CURRENCY,
		reviewToken: '',
		reviewedFingerprint: ''
	};
}
/**
 * What a revision or amendment starts from: the authoritative current state, never the customer's
 * original inquiry. Lines are the current Quote or Invoice; the plan is the effective approval (a
 * cleared or never-approved plan seeds empty and is never resurrected from the original picks); and a
 * Quote revision keeps the negotiated deposit terms rather than the suggested ones.
 */
export function revisionValues(
	data: CurrentStaffRequest,
	mode: Exclude<FinancialEditorMode, 'INITIAL_QUOTE'>
): QuoteFormValues {
	const commitment = serviceCommitment(data);
	const plan = commitment.state === 'APPROVED' ? commitment.plan : null;
	const notes = new Map((plan?.lineNotes ?? []).map((n) => [n.lineItemId, n.note]));
	const suggested = data.suggestedDepositTerms;
	const active = data.depositRequirement.state === 'ACTIVE' ? data.depositRequirement : null;
	const terms = active?.terms ?? suggested;
	const deposit: DepositFormValues | null =
		mode === 'QUOTE_REVISION'
			? {
					expectedVersion: String(data.financial.version),
					depositChoice: terms.type === 'PERCENTAGE' ? 'percentage' : 'fixed',
					reviewedSuggestionType: suggested.type,
					reviewedSuggestionValue: suggestionValue(suggested),
					depositPercentage: terms.type === 'PERCENTAGE' ? terms.percentage : '',
					depositAmount: terms.type === 'FIXED' ? terms.amount : ''
				}
			: null;
	return {
		mode,
		expectedVersion: String(data.financial.version),
		deposit,
		expectedDepositRevision: mode === 'QUOTE_REVISION' && active ? String(active.revision) : '',
		expectedProposalId: mode === 'QUOTE_REVISION' ? (data.proposal?.id ?? '') : '',
		expectedPlanRevision: data.effectiveServicePlan
			? String(data.effectiveServicePlan.revision)
			: '',
		clearPlan: false,
		lines: data.financial.lines.map((l) => ({
			lineItemId: l.id,
			description: l.description,
			subDescription: l.subDescription,
			quantity: l.quantity,
			unitPrice: l.unitPrice,
			taxAmount: l.taxAmount,
			currency: l.currency,
			note: notes.get(l.id) ?? ''
		})),
		description: plan?.description ?? '',
		guestCount: plan?.guestCount ? String(plan.guestCount) : '',
		items: selectionDrafts(plan?.items ?? []),
		reviewedCurrency: CURRENCY,
		reviewToken: '',
		reviewedFingerprint: ''
	};
}
export function editorValues(
	data: CurrentStaffRequest,
	mode: FinancialEditorMode
): QuoteFormValues {
	return mode === 'INITIAL_QUOTE' ? initialQuoteValues(data) : revisionValues(data, mode);
}
/**
 * Whether the state a draft was reviewed against has moved since: the document version, the
 * suggested terms (initial), the deposit revision and publication (Quote revision) or the service
 * approval. Reviewed state that no longer matches requires a reload, never a silent rebase.
 */
export function reviewedStateChanged(values: QuoteFormValues, data: CurrentStaffRequest): boolean {
	if (values.expectedVersion !== String(data.financial.version)) return true;
	if (values.expectedPlanRevision !== String(data.effectiveServicePlan?.revision ?? ''))
		return true;
	if (values.mode === 'INITIAL_QUOTE')
		return (
			!values.deposit || !matchesReviewedSuggestion(values.deposit, data.suggestedDepositTerms)
		);
	if (values.mode === 'QUOTE_REVISION')
		return (
			data.depositRequirement.state !== 'ACTIVE' ||
			values.expectedDepositRevision !== String(data.depositRequirement.revision) ||
			values.expectedProposalId !== (data.proposal?.id ?? '') ||
			!values.deposit ||
			!matchesReviewedSuggestion(values.deposit, data.suggestedDepositTerms)
		);
	return false;
}
export function reviewedTerms(values: DepositFormValues): DepositTermsRequest {
	return values.depositChoice === 'percentage'
		? { type: 'PERCENTAGE', percentage: values.depositPercentage.trim() }
		: values.depositChoice === 'fixed'
			? { type: 'FIXED', amount: values.depositAmount.trim(), currency: CURRENCY }
			: values.reviewedSuggestionType === 'PERCENTAGE'
				? { type: 'PERCENTAGE', percentage: values.reviewedSuggestionValue }
				: { type: 'FIXED', amount: values.reviewedSuggestionValue, currency: CURRENCY };
}
export function readQuoteForm(form: FormData): QuoteFormValues | null {
	const scalar = (name: string) => {
		const a = form.getAll(name);
		return a.length <= 1 && (a.length === 0 || typeof a[0] === 'string')
			? String(a[0] ?? '')
			: null;
	};
	// Forms that predate editor modes are the initial Quote.
	const rawMode = form.has('editorMode') ? scalar('editorMode') : 'INITIAL_QUOTE';
	if (!isEditorMode(rawMode)) return null;
	const mode = rawMode;
	const expectedVersion = scalar('expectedVersion');
	if (
		expectedVersion === null ||
		!/^[1-9]\d*$/.test(expectedVersion) ||
		Number(expectedVersion) > 2_147_483_647
	)
		return null;
	const depositKeys = [
		'expectedVersion',
		'depositChoice',
		'reviewedSuggestionType',
		'reviewedSuggestionValue',
		'depositPercentage',
		'depositAmount'
	];
	let deposit: DepositFormValues | null = null;
	if (mode !== 'INVOICE_AMENDMENT') {
		const depositForm = new FormData();
		for (const key of depositKeys)
			for (const value of form.getAll(key)) depositForm.append(key, value);
		deposit = readDepositForm(depositForm);
		if (!deposit) return null;
	} else if (depositKeys.some((key) => key !== 'expectedVersion' && form.has(key))) return null;
	// Revision identity belongs to exactly the modes that have one.
	const depositRevision = scalar('expectedDepositRevision');
	const proposalId = scalar('expectedProposalId');
	const planRevision = scalar('expectedPlanRevision');
	const clear = form.getAll('clearPlan');
	if (depositRevision === null || proposalId === null || planRevision === null || clear.length > 1)
		return null;
	if (clear.length && clear[0] !== 'on') return null;
	if (
		mode === 'QUOTE_REVISION'
			? !/^[1-9]\d{0,9}$/.test(depositRevision) || !/^[A-Za-z0-9-]{1,64}$/.test(proposalId)
			: depositRevision !== '' || proposalId !== ''
	)
		return null;
	if (planRevision !== '' && !/^[1-9]\d{0,9}$/.test(planRevision)) return null;
	if (mode === 'INITIAL_QUOTE' && (planRevision !== '' || clear.length)) return null;
	// The page echoes the currency it reviewed; anything but USD is refused before any backend call.
	// It never selects validation rules: those are USD's, whatever the browser sends.
	if (!isSupportedCurrency(scalar('reviewedCurrency'))) return null;
	const rows = form.getAll('lineIdentity');
	const names = ['description', 'subDescription', 'quantity', 'unitPrice', 'taxAmount', 'note'];
	if (rows.length > 101 || names.some((n) => form.getAll(n).length !== rows.length)) return null;
	const lines: LineDraft[] = [];
	for (let i = 0; i < rows.length; i++) {
		const identity = rows[i];
		if (typeof identity !== 'string') return null;
		const entries = Object.fromEntries(names.map((n) => [n, form.getAll(n)[i]]));
		if (Object.values(entries).some((v) => typeof v !== 'string')) return null;
		if (
			identity.startsWith('new:') &&
			!String(entries.description).trim() &&
			!String(entries.unitPrice).trim()
		)
			continue;
		const id =
			identity === 'new:blank-row'
				? crypto.randomUUID()
				: identity.substring(identity.indexOf(':') + 1);
		if (
			identity.startsWith('id:')
				? !/^[0-9a-f-]{36}$/i.test(id)
				: !identity.startsWith('new:') || !/^[A-Za-z0-9_-]{1,64}$/.test(id)
		)
			return null;
		const text = (name: string) => String(entries[name]).trim();
		lines.push({
			...(identity.startsWith('id:') ? { lineItemId: id } : { key: id }),
			description: text('description'),
			...(text('subDescription') ? { subDescription: text('subDescription') } : {}),
			...(text('quantity') ? { quantity: text('quantity') } : {}),
			unitPrice: text('unitPrice'),
			taxAmount: text('taxAmount'),
			currency: CURRENCY,
			note: text('note')
		});
	}
	const selections = readSelections(form, scalar);
	if (!selections) return null;
	const { items, fields: selectionFields } = selections;
	const other = ['planDescription', 'planGuestCount', 'reviewToken', 'reviewedFingerprint'];
	const identity = [
		'editorMode',
		'expectedVersion',
		'expectedDepositRevision',
		'expectedProposalId',
		'expectedPlanRevision',
		'clearPlan'
	];
	const vals = other.map(scalar);
	if (vals.some((v) => v === null)) return null;
	const allowed = new Set([
		...other,
		...identity,
		'reviewedCurrency',
		'lineIdentity',
		...names,
		...(mode === 'INVOICE_AMENDMENT' ? [] : depositKeys),
		'rowAction',
		'selectionAction',
		'selectionIdentity',
		...selectionFields
	]);
	if (form.has('rowAction') && form.has('selectionAction')) return null;
	if ([...form.keys()].some((k) => !allowed.has(k))) return null;
	// Native controls perform the same reversible row edits as JavaScript.
	const action = scalar('rowAction');
	if (action === null || (action && !/^(remove|up|down):[0-9]+$/.test(action))) return null;
	if (action) {
		const [kind, index] = action.split(':');
		const i = Number(index);
		if (!Number.isInteger(i) || i < 0 || i >= lines.length) return null;
		if (kind === 'remove') lines.splice(i, 1);
		else if (kind === 'up' && i > 0) [lines[i - 1], lines[i]] = [lines[i], lines[i - 1]];
		else if (kind === 'down' && i < lines.length - 1)
			[lines[i + 1], lines[i]] = [lines[i], lines[i + 1]];
		else return null;
	}
	return {
		mode,
		expectedVersion,
		deposit,
		expectedDepositRevision: depositRevision,
		expectedProposalId: proposalId,
		expectedPlanRevision: planRevision,
		clearPlan: clear.length === 1,
		lines,
		description: vals[0]!,
		guestCount: vals[1]!,
		items,
		reviewToken: vals[2]!,
		reviewedFingerprint: vals[3]!,
		reviewedCurrency: CURRENCY
	};
}

function exact(value: string, maxFraction: number): boolean {
	return new RegExp(`^-?[0-9]{1,9}(\\.[0-9]{1,${maxFraction}})?$`).test(value);
}
function units(value: string): bigint {
	const negative = value.startsWith('-');
	const [whole, fraction = ''] = value.replace('-', '').split('.');
	const n = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
	return negative ? -n : n;
}
/**
 * Staff input checks, all in USD. Flat prices and tax are whole cents; a per-unit rate may carry up
 * to 12 fractional digits when rate × quantity settles exactly to cents. Amounts may be signed
 * (discounts and credits). Nothing is ever rounded: an amount that doesn't settle is refused.
 */
const SELECTION_ROW = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * Selection rows are aligned by identity: `selectionIdentity` lists the overall order, and each
 * identity owns exactly one label, category, source key and source label field. Text is kept as
 * typed so a re-rendered draft never trims under the cursor; `buildCommand` canonicalizes it.
 */
function readSelections(form: FormData, scalar: (name: string) => string | null) {
	const identities = form.getAll('selectionIdentity');
	if (identities.length > MAX_SELECTIONS) return null;
	const fields: string[] = [];
	const items: SelectionDraft[] = [];
	for (const identity of identities) {
		if (typeof identity !== 'string' || !SELECTION_ROW.test(identity)) return null;
		const names = ['selectionLabel', 'selectionGroup', 'selectionKey', 'selectionSource'].map(
			(n) => `${n}:${identity}`
		);
		if (fields.includes(names[0])) return null;
		fields.push(...names);
		const [label, group, key, sourceLabel] = names.map(scalar);
		if (
			label === null ||
			group === null ||
			key === null ||
			sourceLabel === null ||
			label.trim().length > LABEL_MAX ||
			group.trim().length > GROUP_MAX ||
			key.trim().length > KEY_MAX ||
			sourceLabel.trim().length > LABEL_MAX ||
			names.some((n) => !form.has(n))
		)
			return null;
		items.push({ rowId: identity, label, group, key: key.trim() || null, sourceLabel });
	}
	// Selection edits have their own action namespace; financial rows use `rowAction`.
	const action = scalar('selectionAction');
	if (action === null) return null;
	if (action === 'add') {
		if (items.length >= MAX_SELECTIONS) return null;
		items.push({ rowId: crypto.randomUUID(), label: '', group: '', key: null, sourceLabel: '' });
	} else if (action) {
		const match = /^(remove|up|down):([A-Za-z0-9_-]{1,64})$/.exec(action);
		const i = match ? items.findIndex((item) => item.rowId === match[2]) : -1;
		if (!match || i < 0) return null;
		if (match[1] === 'remove') items.splice(i, 1);
		else {
			const j = i + (match[1] === 'up' ? -1 : 1);
			if (j < 0 || j >= items.length) return null;
			[items[i], items[j]] = [items[j], items[i]];
		}
	}
	return { items, fields };
}
/** Unused blank placeholder rows are dropped; everything else is part of the commitment. */
const committedSelections = (items: SelectionDraft[]) => items.filter((i) => !isPlaceholder(i));
export function quoteInputErrors(values: QuoteFormValues): Record<string, string> {
	const errors: Record<string, string> = {};
	const cents = (s: string) => exact(s, CENT_DIGITS);
	if (!values.lines.length || values.lines.length > 100) errors.lines = 'Supply 1–100 final lines.';
	if (new Set(values.lines.map((l) => l.lineItemId ?? l.key)).size !== values.lines.length)
		errors.lines = 'Each line needs a unique identity.';
	values.lines.forEach((l, i) => {
		if (
			!l.description ||
			l.description.length > 200 ||
			(l.subDescription?.length ?? 0) > 500 ||
			l.note.length > 500 ||
			!isSupportedCurrency(l.currency) ||
			!exact(l.unitPrice, l.quantity ? 12 : CENT_DIGITS) ||
			!cents(l.taxAmount) ||
			(l.quantity && (!exact(l.quantity, 6) || units(l.quantity) === 0n))
		) {
			errors[`line-${i}`] = 'Check the description, exact amount, quantity and tax.';
			return;
		}
		const subtotal = l.quantity
			? (units(l.unitPrice) * units(l.quantity)) / 10n ** 18n
			: units(l.unitPrice);
		if (subtotal % 10n ** BigInt(18 - CENT_DIGITS) !== 0n)
			errors[`line-${i}`] = 'This rate and quantity do not settle exactly; no rounding is allowed.';
	});
	const count = (s: string, max: number) => !s || (/^[1-9]\d*$/.test(s) && Number(s) <= max);
	if (values.description.length > 2000 || !count(values.guestCount, 100000))
		errors.service = 'Check the approved service description and counts.';
	if (values.items.length > MAX_SELECTIONS)
		errors.selections = `A serving plan lists at most ${MAX_SELECTIONS} selections.`;
	// Keyed by draft position, which the editor shows; selection errors never touch line totals.
	values.items.forEach((item, i) => {
		if (isPlaceholder(item)) return;
		const name = `Selection ${i + 1}`;
		if (!item.label.trim())
			errors[`selection-${i}`] = `${name} needs a label. Remove it if it isn’t needed.`;
		else if (!isServicePlanItem(canonicalSelection(item)))
			errors[`selection-${i}`] =
				`${name}: keep the label to ${LABEL_MAX} characters and the category to ${GROUP_MAX}.`;
	});
	if (
		values.mode === 'INITIAL_QUOTE' &&
		!values.description.trim() &&
		values.lines.some((l) => l.note.trim())
	)
		errors.service = 'Add a service description to preserve the line notes with this quote.';
	if (
		values.deposit &&
		(depositInputError(values.deposit) || !isDepositTerms(reviewedTerms(values.deposit), CURRENCY))
	)
		errors.deposit = 'Check deposit terms.';
	return errors;
}
function proposedLines(values: QuoteFormValues): ProposedLine[] {
	return values.lines.map(({ note, ...line }) => {
		void note;
		return line;
	});
}
/** The complete plan the draft proposes: description required, order and optional metadata kept. */
export function proposedServicePlan(values: QuoteFormValues): QuoteCommand['servicePlan'] {
	const description = values.description.trim();
	if (!description) return undefined;
	return {
		description,
		...(values.guestCount ? { guestCount: Number(values.guestCount) } : {}),
		// Exactly the reviewed order; editor row IDs never leave the admin.
		items: committedSelections(values.items).map(canonicalSelection),
		lineNotes: values.lines
			.filter((l) => l.note)
			.map((l) => ({
				...(l.lineItemId ? { lineItemId: l.lineItemId } : { key: l.key }),
				note: l.note
			}))
	};
}
/** The initial Quote: a plan accompanies it exactly when a description was written. */
export function buildCommand(values: QuoteFormValues): QuoteCommand {
	const servicePlan = proposedServicePlan(values);
	return { lines: proposedLines(values), ...(servicePlan ? { servicePlan } : {}) };
}
/** A revision always names its plan action; REPLACE alone carries the complete proposed plan. */
export function buildRevisionCommand(
	values: QuoteFormValues,
	intent: {
		action: RevisionCommand['servicePlanAction'];
		servicePlan?: QuoteCommand['servicePlan'];
	}
): RevisionCommand {
	return {
		lines: proposedLines(values),
		servicePlanAction: intent.action,
		...(intent.action === 'REPLACE' && intent.servicePlan
			? { servicePlan: intent.servicePlan }
			: {})
	};
}
/** The preview must describe exactly the selections the command proposed, in order. */
export function previewMatchesSelections(
	command: QuoteCommand,
	preview: { servicePlan?: { items: ServicePlanItem[] } | null }
): boolean {
	if (!command.servicePlan) return true;
	const proposed = command.servicePlan.items ?? [];
	const shown = preview.servicePlan?.items;
	return (
		!!shown &&
		shown.length === proposed.length &&
		shown.every(
			(item, i) =>
				item.label === proposed[i].label &&
				(item.group ?? null) === (proposed[i].group ?? null) &&
				(item.key ?? null) === (proposed[i].key ?? null)
		)
	);
}
export function isQuotePreview(
	value: unknown,
	scope: { inquiryId: string; documentId?: string; revision?: boolean }
): value is InquiryQuotePreviewResponse {
	if (!value || typeof value !== 'object') return false;
	const p = value as InquiryQuotePreviewResponse;
	const amount = (v: unknown) => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);
	return (
		p.inquiryId === scope.inquiryId &&
		(!scope.documentId || p.documentId === scope.documentId) &&
		isSupportedCurrency(p.currency) &&
		Number.isInteger(p.reviewedDocumentVersion) &&
		p.reviewedDocumentVersion > 0 &&
		Number.isInteger(p.quoteVersion) &&
		// An initial Quote always follows the Estimate it reviewed. A revision's version equals the
		// reviewed one when only the service or the deposit changes: no financial version is invented.
		(scope.revision
			? p.quoteVersion >= p.reviewedDocumentVersion
			: p.quoteVersion > p.reviewedDocumentVersion) &&
		typeof p.financialChange === 'boolean' &&
		typeof p.reviewToken === 'string' &&
		/^[a-f0-9]{64}$/.test(p.reviewToken) &&
		[p.estimateTotal, p.subtotal, p.taxAmount, p.total].every(amount) &&
		Array.isArray(p.lines) &&
		p.lines.length > 0 &&
		p.lines.every((l) => l && typeof l === 'object') &&
		new Set(p.lines.map((l) => l.id)).size === p.lines.length &&
		p.lines.every(
			(l) =>
				typeof l.id === 'string' &&
				!!l.id &&
				['CARRIED', 'REPLACED', 'NEW'].includes(l.origin) &&
				typeof l.description === 'string' &&
				l.currency === p.currency &&
				[l.unitPrice, l.subtotal, l.taxAmount, l.total].every(amount)
		) &&
		(p.servicePlan == null ||
			(typeof p.servicePlan.description === 'string' &&
				!!p.servicePlan.description.trim() &&
				p.servicePlan.description.length <= 2000 &&
				isServicePlanItems(p.servicePlan.items))) &&
		!!p.deposit &&
		isDepositTerms(p.deposit.terms, p.currency) &&
		amount(p.deposit.requiredAmount?.amount) &&
		p.deposit.requiredAmount.currency === p.currency
	);
}

const amount = (v: unknown) => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);
const revisionNumber = (v: unknown) =>
	v == null || (typeof v === 'number' && Number.isInteger(v) && v > 0);
/** A previewed plan: required description, valid selections, notes naming the previewed lines. */
function isPlanPreview(plan: unknown, lineIds: Set<string>): boolean {
	if (plan == null) return true;
	const p = plan as NonNullable<InquiryQuotePreviewResponse['servicePlan']>;
	return (
		typeof p.description === 'string' &&
		!!p.description.trim() &&
		p.description.length <= 2000 &&
		isServicePlanItems(p.items) &&
		Array.isArray(p.lineNotes) &&
		p.lineNotes.every((n) => typeof n?.note === 'string' && lineIds.has(n.lineItemId))
	);
}
export function isQuoteRevisionPreview(
	value: unknown,
	scope: { inquiryId: string; documentId: string }
): value is QuoteRevisionPreviewResponse {
	if (!value || typeof value !== 'object') return false;
	const p = value as QuoteRevisionPreviewResponse;
	return (
		isQuotePreview(p.quote, { ...scope, revision: true }) &&
		isPlanPreview(p.quote.servicePlan, new Set(p.quote.lines.map((l) => l.id))) &&
		typeof p.currentProposalId === 'string' &&
		!!p.currentProposalId &&
		Number.isInteger(p.reviewedDepositRequirementRevision) &&
		p.reviewedDepositRequirementRevision > 0 &&
		revisionNumber(p.currentServicePlanRevision) &&
		revisionNumber(p.resultingServicePlanRevision) &&
		typeof p.servicePlanChange === 'boolean' &&
		typeof p.depositChange === 'boolean'
	);
}
export function isInvoiceRevisionPreview(
	value: unknown,
	scope: { inquiryId: string; documentId: string }
): value is InvoiceRevisionPreviewResponse {
	if (!value || typeof value !== 'object') return false;
	const p = value as InvoiceRevisionPreviewResponse;
	return (
		p.inquiryId === scope.inquiryId &&
		p.documentId === scope.documentId &&
		isSupportedCurrency(p.currency) &&
		Number.isInteger(p.reviewedDocumentVersion) &&
		p.reviewedDocumentVersion > 0 &&
		Number.isInteger(p.resultingDocumentVersion) &&
		// Only a financial change appends a version; a service-only amendment keeps it.
		p.resultingDocumentVersion === p.reviewedDocumentVersion + (p.financialChange ? 1 : 0) &&
		typeof p.financialChange === 'boolean' &&
		typeof p.servicePlanChange === 'boolean' &&
		revisionNumber(p.currentServicePlanRevision) &&
		revisionNumber(p.resultingServicePlanRevision) &&
		['UNDERPAID', 'SETTLED', 'OVERPAID'].includes(p.settlement) &&
		[p.currentTotal, p.total, p.subtotal, p.taxAmount, p.netApplied, p.balance].every(amount) &&
		typeof p.reviewToken === 'string' &&
		/^[a-f0-9]{64}$/.test(p.reviewToken) &&
		Array.isArray(p.lines) &&
		p.lines.length > 0 &&
		p.lines.every((l) => l && typeof l === 'object') &&
		new Set(p.lines.map((l) => l.id)).size === p.lines.length &&
		p.lines.every(
			(l) =>
				typeof l.id === 'string' &&
				!!l.id &&
				['CARRIED', 'REPLACED', 'NEW'].includes(l.origin) &&
				typeof l.description === 'string' &&
				l.currency === p.currency &&
				[l.unitPrice, l.subtotal, l.taxAmount, l.total].every(amount)
		) &&
		isPlanPreview(p.servicePlan, new Set(p.lines.map((l) => l.id)))
	);
}
