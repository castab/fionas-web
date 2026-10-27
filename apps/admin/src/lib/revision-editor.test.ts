import { describe, expect, it } from 'vitest';
import {
	buildCommand,
	buildRevisionCommand,
	editorValues,
	initialQuoteValues,
	isInvoiceRevisionPreview,
	isQuotePreview,
	isQuoteRevisionPreview,
	quoteInputErrors,
	readQuoteForm,
	reviewedStateChanged,
	reviewedTerms,
	type QuoteFormValues
} from './quote-builder.js';
import { droppedNotes, planIntent } from './service-plan-edit.js';
import { reviewFingerprint } from './server/quote-review.js';
import { decimalDifference, changeLabel } from './comparison.js';
import {
	approvalEntries,
	isDepositRequirementHistory,
	isFinancialDocumentHistory,
	publicationEntries
} from './revision-history.js';
import { canonicalSelection } from './service-selections.js';
import { postedForm as post } from './revision-form.testing.js';
import { mayaId, requestFixtures } from '../../e2e/request-fixture.mjs';
import {
	previewInvoiceRevision,
	previewQuoteRevision,
	ensureHistory
} from '../../e2e/revision-stub.mjs';
import {
	negotiatedQuote,
	repricedLines,
	revisionFixture,
	withCharge
} from '../../e2e/revision-fixture.mjs';

describe('the editor starts from the authoritative current state', () => {
	it('seeds an initial quote from the Estimate, the customer’s picks and suggested terms', () => {
		const data = requestFixtures()[mayaId];
		const v = editorValues(data, 'INITIAL_QUOTE');
		expect(v).toMatchObject({ mode: 'INITIAL_QUOTE', description: 'Ice cream service' });
		expect(v.deposit?.depositChoice).toBe('suggested');
		expect(v.items.map((i) => i.label)).toContain('Birthday candles');
		expect(v.expectedDepositRevision).toBe('');
	});
	it('keeps negotiated deposit terms when revising a quote, not the suggested 20%', () => {
		const data = negotiatedQuote();
		const v = editorValues(data, 'QUOTE_REVISION');
		expect(v.deposit).toMatchObject({
			depositChoice: 'fixed',
			depositAmount: '250.00',
			reviewedSuggestionType: 'PERCENTAGE',
			reviewedSuggestionValue: '20'
		});
		expect(reviewedTerms(v.deposit!)).toEqual({ type: 'FIXED', amount: '250.00', currency: 'USD' });
		expect(v.expectedDepositRevision).toBe('2');
		expect(v.expectedProposalId).toBe(data.proposal!.id);
	});
	it('seeds a percentage deposit as a custom percentage', () => {
		const v = editorValues(revisionFixture('quote-deposit-revision'), 'QUOTE_REVISION');
		expect(v.deposit).toMatchObject({ depositChoice: 'percentage', depositPercentage: '35' });
	});
	it('seeds the approved plan and notes, never the original inquiry picks', () => {
		const data = revisionFixture('quoted');
		const v = editorValues(data, 'QUOTE_REVISION');
		expect(v.description).toBe(data.effectiveServicePlan!.description);
		expect(v.guestCount).toBe('40');
		expect(v.items.map((i) => i.label)).toEqual(['Churros', 'Vanilla']);
		expect(v.lines[0].note).toBe('Negotiated');
		expect(v.expectedPlanRevision).toBe('1');
	});
	it('seeds an invoice amendment from the effective plan with no deposit field', () => {
		const data = revisionFixture('invoice-service-amendment');
		const v = editorValues(data, 'INVOICE_AMENDMENT');
		expect(v.deposit).toBeNull();
		expect(v.description).toBe('Chocolate topping instead of vanilla');
		expect(v.expectedPlanRevision).toBe('2');
		expect(v.expectedProposalId).toBe('');
		expect(v.lines.map((l) => l.lineItemId)).toEqual(data.financial.lines.map((l) => l.id));
	});
	it('does not resurrect a cleared plan or fall back to the customer’s picks', () => {
		const data = revisionFixture('plan-cleared');
		const v = editorValues(data, 'INVOICE_AMENDMENT');
		expect(v.description).toBe('');
		expect(v.items).toEqual([]);
		expect(v.guestCount).toBe('');
		expect(v.lines.every((l) => l.note === '')).toBe(true);
		expect(v.expectedPlanRevision).toBe('2');
		// A never-approved plan seeds the same empty draft.
		const never = editorValues(revisionFixture('booked'), 'INVOICE_AMENDMENT');
		expect(never.description).toBe('Churro catering for an evening reception');
		const none = requestFixtures()[mayaId];
		none.inquiry.lifecycle.stage = 'BOOKED';
		expect(editorValues(none, 'INVOICE_AMENDMENT').description).toBe('');
	});
});

describe('the service plan action is derived, never guessed', () => {
	const draft = (state = 'quoted' as Parameters<typeof revisionFixture>[0]) => {
		const data = revisionFixture(state);
		return { data, values: editorValues(data, 'QUOTE_REVISION') };
	};
	it('retains an untouched plan even when only financial lines change', () => {
		const { data, values } = draft();
		values.lines[0].unitPrice = '300.00';
		expect(planIntent(values, data)).toEqual({ ok: true, action: 'RETAIN' });
		const command = buildRevisionCommand(values, planIntent(values, data) as never);
		expect(command.servicePlanAction).toBe('RETAIN');
		expect(command).not.toHaveProperty('servicePlan');
	});
	it.each([
		['description', (v: QuoteFormValues) => (v.description = 'Now with sprinkles')],
		['guest count', (v: QuoteFormValues) => (v.guestCount = '55')],
		['a selection', (v: QuoteFormValues) => (v.items[1].label = 'Chocolate')],
		['selection order', (v: QuoteFormValues) => v.items.reverse()],
		['a line note', (v: QuoteFormValues) => (v.lines[0].note = 'Changed note')],
		['a removed note', (v: QuoteFormValues) => (v.lines[0].note = '')]
	])('replaces the plan when %s changes', (_name, edit) => {
		const { data, values } = draft();
		edit(values);
		const intent = planIntent(values, data);
		expect(intent).toMatchObject({ ok: true, action: 'REPLACE' });
		const command = buildRevisionCommand(values, intent as never);
		expect(command.servicePlan?.description).toBeTruthy();
		// Complete and ordered, with the optional metadata the staff kept.
		expect(command.servicePlan?.items).toEqual(
			values.items.map((item) => canonicalSelection(item))
		);
	});
	it('never clears because a description went blank', () => {
		const { data, values } = draft();
		values.description = '';
		const intent = planIntent(values, data);
		expect(intent.ok).toBe(false);
		expect(!intent.ok && intent.error).toMatch(/Remove the service plan/);
	});
	it('clears only on the deliberate choice, and only an approved plan', () => {
		const { data, values } = draft();
		values.clearPlan = true;
		values.description = 'ignored while clearing';
		expect(planIntent(values, data)).toEqual({ ok: true, action: 'CLEAR' });
		const cleared = revisionFixture('plan-cleared');
		const again = editorValues(cleared, 'INVOICE_AMENDMENT');
		again.clearPlan = true;
		expect(planIntent(again, cleared).ok).toBe(false);
		const never = requestFixtures()[mayaId];
		const none = editorValues(never, 'QUOTE_REVISION');
		none.clearPlan = true;
		expect(planIntent(none, never).ok).toBe(false);
	});
	it('keeps an absent or cleared plan absent unless staff write a new one', () => {
		const cleared = revisionFixture('plan-cleared');
		const values = editorValues(cleared, 'INVOICE_AMENDMENT');
		expect(planIntent(values, cleared)).toEqual({ ok: true, action: 'RETAIN' });
		values.description = 'A new commitment';
		expect(planIntent(values, cleared)).toMatchObject({ ok: true, action: 'REPLACE' });
	});
	it('refuses guests, selections or notes without a description', () => {
		const cleared = revisionFixture('plan-cleared');
		const values = editorValues(cleared, 'INVOICE_AMENDMENT');
		values.guestCount = '40';
		expect(planIntent(values, cleared).ok).toBe(false);
	});
	it('lists notes that leave with a removed line, and requires the plan to be replaced', () => {
		const { data, values } = draft();
		values.lines = values.lines.slice(1);
		expect(droppedNotes(values, data)).toEqual([
			{
				lineItemId: data.financial.lines[0].id,
				description: data.financial.lines[0].description,
				note: 'Negotiated'
			}
		]);
		// The posted draft no longer carries the note, so the plan cannot be retained.
		expect(planIntent(values, data)).toMatchObject({ ok: true, action: 'REPLACE' });
		expect(droppedNotes(editorValues(data, 'QUOTE_REVISION'), data)).toEqual([]);
	});
	it('preserves new-line identity with a key and notes on it', () => {
		const { data, values } = draft();
		values.lines.push({
			key: 'extra-hour',
			description: 'Extra hour',
			unitPrice: '50.00',
			taxAmount: '0.00',
			currency: 'USD',
			note: 'Asked for at the tasting'
		});
		const intent = planIntent(values, data);
		const command = buildRevisionCommand(values, intent as never);
		expect(command.lines.at(-1)).toMatchObject({ key: 'extra-hour' });
		expect(command.lines.at(-1)).not.toHaveProperty('lineItemId');
		expect(command.lines[0]).toHaveProperty('lineItemId', data.financial.lines[0].id);
		expect(command.servicePlan?.lineNotes).toContainEqual({
			key: 'extra-hour',
			note: 'Asked for at the tasting'
		});
	});
	it('carries an unedited duration instead of silently dropping it', () => {
		const { data, values } = draft();
		data.effectiveServicePlan!.durationMinutes = 90;
		values.description = 'Changed';
		const intent = planIntent(values, data);
		expect(intent).toMatchObject({ ok: true, servicePlan: { durationMinutes: 90 } });
		// …but the app never authors one for an initial quote.
		expect(
			buildCommand(initialQuoteValues(requestFixtures()[mayaId])).servicePlan
		).not.toHaveProperty('durationMinutes');
	});
});

describe('reading a posted revision form', () => {
	const values = (
		state: Parameters<typeof revisionFixture>[0],
		mode: 'QUOTE_REVISION' | 'INVOICE_AMENDMENT'
	) => editorValues(revisionFixture(state), mode);
	it('round-trips a quote revision with its identity', () => {
		const v = values('quoted', 'QUOTE_REVISION');
		const read = readQuoteForm(post(v));
		expect(read).toMatchObject({
			mode: 'QUOTE_REVISION',
			expectedVersion: '2',
			expectedDepositRevision: '1',
			expectedPlanRevision: '1',
			clearPlan: false
		});
		expect(read?.expectedProposalId).toBe(v.expectedProposalId);
	});
	it('round-trips an invoice amendment, which posts no deposit field', () => {
		const v = values('booked', 'INVOICE_AMENDMENT');
		const read = readQuoteForm(post(v));
		expect(read).toMatchObject({ mode: 'INVOICE_AMENDMENT', deposit: null, expectedVersion: '3' });
	});
	it.each(['depositChoice', 'depositAmount', 'depositPercentage', 'reviewedSuggestionType'])(
		'refuses a posted %s on an invoice amendment',
		(field) => {
			const f = post(values('booked', 'INVOICE_AMENDMENT'), { [field]: '20' });
			expect(readQuoteForm(f)).toBeNull();
		}
	);
	it('refuses revision identity on the wrong mode, and an unknown or missing one', () => {
		const q = values('quoted', 'QUOTE_REVISION');
		expect(readQuoteForm(post(q, { editorMode: 'NOPE' }))).toBeNull();
		expect(readQuoteForm(post(q, { expectedDepositRevision: '' }))).toBeNull();
		expect(readQuoteForm(post(q, { expectedProposalId: '' }))).toBeNull();
		expect(readQuoteForm(post(q, { expectedPlanRevision: '0' }))).toBeNull();
		const inv = values('booked', 'INVOICE_AMENDMENT');
		expect(readQuoteForm(post(inv, { expectedDepositRevision: '1' }))).toBeNull();
		expect(readQuoteForm(post(inv, { expectedProposalId: 'abc' }))).toBeNull();
		const initial = initialQuoteValues(requestFixtures()[mayaId]);
		expect(readQuoteForm(post(initial, { clearPlan: 'on' }))).toBeNull();
		expect(readQuoteForm(post(initial, { expectedPlanRevision: '1' }))).toBeNull();
		expect(readQuoteForm(post(q, { clearPlan: 'yes' }))).toBeNull();
	});
	it('reads the deliberate clear choice', () => {
		const q = values('quoted', 'QUOTE_REVISION');
		expect(readQuoteForm(post({ ...q, clearPlan: true }))?.clearPlan).toBe(true);
	});
	it('treats a form with no editor mode as the initial quote', () => {
		const f = post(initialQuoteValues(requestFixtures()[mayaId]));
		f.delete('editorMode');
		expect(readQuoteForm(f)?.mode).toBe('INITIAL_QUOTE');
	});
	it('validates a revision draft without any deposit', () => {
		expect(quoteInputErrors(values('booked', 'INVOICE_AMENDMENT'))).toEqual({});
	});
});

describe('reviewed state moves are detected', () => {
	it('flags a changed document, deposit revision, proposal or plan approval', () => {
		const data = revisionFixture('quoted');
		const v = editorValues(data, 'QUOTE_REVISION');
		expect(reviewedStateChanged(v, data)).toBe(false);
		const moved = (edit: (d: typeof data) => void) => {
			const copy = structuredClone(data);
			edit(copy);
			return reviewedStateChanged(v, copy);
		};
		expect(moved((d) => d.financial.version++)).toBe(true);
		expect(moved((d) => (d.proposal!.id = 'someone-elses'))).toBe(true);
		expect(
			moved((d) => {
				if (d.depositRequirement.state === 'ACTIVE') d.depositRequirement.revision++;
			})
		).toBe(true);
		expect(moved((d) => (d.effectiveServicePlan!.revision = 9))).toBe(true);
		expect(moved((d) => (d.effectiveServicePlan = null))).toBe(true);
	});
});

describe('the review fingerprint binds the whole reviewed intent', () => {
	const base = () => {
		const data = revisionFixture('quoted');
		const v = editorValues(data, 'QUOTE_REVISION');
		const command = buildRevisionCommand(v, planIntent(v, data) as never);
		return {
			mode: 'QUOTE_REVISION' as const,
			expectedDocumentVersion: 2,
			expectedDepositRevision: 1,
			expectedProposalId: data.proposal!.id,
			expectedPlanRevision: 1 as number | null,
			command,
			terms: reviewedTerms(v.deposit!)
		};
	};
	it('is stable for identical intent and changes with any part of it', () => {
		const identity = base();
		const hash = reviewFingerprint(identity);
		expect(reviewFingerprint(base())).toBe(hash);
		const differs = (change: Partial<ReturnType<typeof base>>) =>
			reviewFingerprint({ ...identity, ...change });
		expect(differs({ mode: 'INVOICE_AMENDMENT' as never })).not.toBe(hash);
		expect(differs({ expectedDocumentVersion: 3 })).not.toBe(hash);
		expect(differs({ expectedDepositRevision: 2 })).not.toBe(hash);
		expect(differs({ expectedProposalId: 'other' })).not.toBe(hash);
		expect(differs({ expectedPlanRevision: 2 })).not.toBe(hash);
		expect(differs({ expectedPlanRevision: null })).not.toBe(hash);
		expect(differs({ terms: { type: 'PERCENTAGE', percentage: '30' } })).not.toBe(hash);
		expect(differs({ command: { ...identity.command, servicePlanAction: 'CLEAR' } })).not.toBe(
			hash
		);
		const lines = structuredClone(identity.command.lines);
		lines[0].unitPrice = '1.00';
		expect(differs({ command: { ...identity.command, lines } })).not.toBe(hash);
	});
	it('hashes equal terms alike however they arrived', () => {
		const identity = base();
		expect(
			reviewFingerprint({ ...identity, terms: { type: 'PERCENTAGE', percentage: '20' } })
		).toBe(
			reviewFingerprint({
				...identity,
				terms: { percentage: '20', type: 'PERCENTAGE' } as never
			})
		);
	});
});

describe('preview validation', () => {
	const scope = (id: string, documentId: string) => ({ inquiryId: id, documentId });
	it('accepts a service-only quote revision that keeps its version, and refuses it as an initial quote', () => {
		const data = revisionFixture('quoted');
		const v = editorValues(data, 'QUOTE_REVISION');
		v.description = 'A different service';
		const command = buildRevisionCommand(v, planIntent(v, data) as never);
		const result = previewQuoteRevision({}, data, {
			expectedDocumentVersion: 2,
			expectedDepositRequirementRevision: 1,
			...command,
			terms: reviewedTerms(v.deposit!)
		});
		expect(result.status).toBe(200);
		const preview = result.body;
		expect(preview.quote.quoteVersion).toBe(2);
		expect(preview.quote.financialChange).toBe(false);
		expect(preview.servicePlanChange).toBe(true);
		expect(preview.resultingServicePlanRevision).toBe(2);
		expect(isQuoteRevisionPreview(preview, scope(data.inquiry.id, data.financial.id))).toBe(true);
		expect(isQuotePreview(preview.quote, scope(data.inquiry.id, data.financial.id))).toBe(false);
		expect(
			isQuotePreview(preview.quote, {
				...scope(data.inquiry.id, data.financial.id),
				revision: true
			})
		).toBe(true);
	});
	it('refuses a revision preview for another inquiry or a malformed token', () => {
		const data = revisionFixture('quoted');
		const v = editorValues(data, 'QUOTE_REVISION');
		v.lines[0].unitPrice = '300.00';
		const result = previewQuoteRevision({}, data, {
			expectedDocumentVersion: 2,
			expectedDepositRequirementRevision: 1,
			...buildRevisionCommand(v, planIntent(v, data) as never),
			terms: reviewedTerms(v.deposit!)
		});
		expect(isQuoteRevisionPreview(result.body, scope('another', data.financial.id))).toBe(false);
		const broken = structuredClone(result.body);
		broken.quote.reviewToken = 'zero';
		expect(isQuoteRevisionPreview(broken, scope(data.inquiry.id, data.financial.id))).toBe(false);
		const noProposal = structuredClone(result.body);
		delete noProposal.currentProposalId;
		expect(isQuoteRevisionPreview(noProposal, scope(data.inquiry.id, data.financial.id))).toBe(
			false
		);
	});
	it('validates invoice reconciliation, settlement and the version it would create', () => {
		const data = revisionFixture('booked');
		const result = previewInvoiceRevision({}, data, {
			expectedDocumentVersion: data.financial.version,
			lines: withCharge(data, '250.00'),
			servicePlanAction: 'RETAIN'
		});
		expect(result.status).toBe(200);
		const preview = result.body;
		expect(preview).toMatchObject({
			resultingDocumentVersion: data.financial.version + 1,
			currentTotal: '415.00',
			total: '665.00',
			// The accepted $300 deposit stays applied; nothing recomputes it against the new total.
			netApplied: '300.00',
			balance: '365.00',
			settlement: 'UNDERPAID',
			financialChange: true,
			servicePlanChange: false
		});
		const ok = scope(data.inquiry.id, data.financial.id);
		expect(isInvoiceRevisionPreview(preview, ok)).toBe(true);
		for (const corrupt of [
			(p: Record<string, unknown>) => (p.settlement = 'REFUNDED'),
			(p: Record<string, unknown>) => (p.balance = 'many'),
			(p: Record<string, unknown>) => (p.resultingDocumentVersion = 99),
			(p: Record<string, unknown>) => (p.reviewToken = 'abc'),
			(p: Record<string, unknown>) => (p.currency = 'EUR'),
			(p: Record<string, unknown>) => (p.documentId = 'other')
		]) {
			const broken = structuredClone(preview);
			corrupt(broken);
			expect(isInvoiceRevisionPreview(broken, ok)).toBe(false);
		}
	});
	it('reports a service-only amendment without a new financial version, and an overpayment', () => {
		const data = revisionFixture('booked');
		const v = editorValues(data, 'INVOICE_AMENDMENT');
		v.items[1].label = 'Chocolate';
		const service = previewInvoiceRevision({}, data, {
			expectedDocumentVersion: data.financial.version,
			...buildRevisionCommand(v, planIntent(v, data) as never)
		}).body;
		expect(service).toMatchObject({
			financialChange: false,
			servicePlanChange: true,
			resultingDocumentVersion: data.financial.version,
			resultingServicePlanRevision: 2
		});
		const over = previewInvoiceRevision({}, data, {
			expectedDocumentVersion: data.financial.version,
			lines: repricedLines(data, '1.00').map((l, i) => (i ? { ...l, unitPrice: '0.00' } : l)),
			servicePlanAction: 'RETAIN'
		}).body;
		expect(over.settlement).toBe('OVERPAID');
		expect(over.balance.startsWith('-')).toBe(true);
	});
	it('answers an untouched draft with the backend’s no-op refusal', () => {
		const data = revisionFixture('booked');
		const v = editorValues(data, 'INVOICE_AMENDMENT');
		const result = previewInvoiceRevision({}, data, {
			expectedDocumentVersion: data.financial.version,
			...buildRevisionCommand(v, planIntent(v, data) as never)
		});
		expect(result).toMatchObject({ status: 422 });
		expect(result.body.violations).toEqual([{ code: 'NO_MATERIAL_CHANGE' }]);
	});
});

describe('presentation helpers', () => {
	it('computes an exact signed difference without floating point', () => {
		expect(decimalDifference('1200.00', '1450.00')).toBe('250.00');
		expect(decimalDifference('1450.00', '1200.00')).toBe('-250.00');
		expect(decimalDifference('0.10', '0.30')).toBe('0.20');
		expect(decimalDifference('1.005', '1.00')).toBe('-0.005');
		expect(decimalDifference('x', '1')).toBeNull();
		expect(changeLabel('250.00', 'USD')).toBe('+$250');
		expect(changeLabel('-250.00', 'USD')).toBe('−$250');
		expect(changeLabel('0.50', 'USD')).toBe('+$0.50');
		expect(changeLabel('0.00', 'USD')).toBe('No change');
		expect(changeLabel(null, 'USD')).toBe('—');
	});
});

describe('revision history presentation', () => {
	it('keeps publications and service approvals as separate facts', () => {
		const data = revisionFixture('quote-service-revision');
		const publications = publicationEntries(data);
		expect(publications.map((p) => [p.kind, p.status, p.changes])).toEqual([
			['Quote revised', 'Current', ['Service plan']],
			['Quote issued', 'Superseded', []]
		]);
		expect(publications[0].plan?.revision).toBe(2);
		expect(publications[0].proposal.documentVersion).toBe(publications[1].proposal.documentVersion);
		const approvals = approvalEntries(data);
		expect(approvals.map((a) => [a.plan.revision, a.label, a.current])).toEqual([
			[2, 'Service plan updated', true],
			[1, 'Service plan approved', false]
		]);
	});
	it('marks the accepted quote and the deposit-only change from facts alone', () => {
		const deposit = publicationEntries(revisionFixture('quote-deposit-revision'));
		expect(deposit[0].changes).toEqual(['Deposit terms']);
		const priced = publicationEntries(revisionFixture('quote-financial-revision'));
		expect(priced[0].changes).toEqual(['Pricing', 'Deposit terms']);
		const booked = publicationEntries(revisionFixture('invoice-financial-amendment'));
		// An Invoice amendment appends no proposal: the quote that booked stays the accepted one.
		expect(booked).toHaveLength(1);
		expect(booked[0].status).toBe('Accepted');
	});
	it('shows a clearing as its own entry and the accepted plan beside the current one', () => {
		const entries = approvalEntries(revisionFixture('plan-cleared'));
		expect(entries[0]).toMatchObject({
			label: 'Service plan removed',
			current: true,
			source: 'Invoice'
		});
		expect(entries[1]).toMatchObject({ accepted: true, current: false, source: 'Quote' });
	});
	it('validates the optional financial and deposit histories', () => {
		const data = revisionFixture('quote-financial-revision');
		const h = ensureHistory(data);
		const documents = { id: data.financial.id, inquiryId: data.inquiry.id, versions: h.versions };
		const scope = {
			documentId: data.financial.id,
			inquiryId: data.inquiry.id,
			latestVersion: data.financial.version
		};
		expect(isFinancialDocumentHistory(documents, scope)).toBe(true);
		expect(isFinancialDocumentHistory({ ...documents, versions: [] }, scope)).toBe(false);
		expect(isFinancialDocumentHistory({ ...documents, versions: 'many' }, scope)).toBe(false);
		expect(
			isFinancialDocumentHistory({ ...documents, versions: [...h.versions].reverse() }, scope)
		).toBe(false);
		expect(isFinancialDocumentHistory({ ...documents, id: 'other' }, scope)).toBe(false);
		expect(isFinancialDocumentHistory(documents, { ...scope, latestVersion: 9 })).toBe(false);
		const deposits = { revisions: h.deposits };
		expect(
			isDepositRequirementHistory(deposits, { documentId: data.financial.id, currency: 'USD' })
		).toBe(true);
		expect(
			isDepositRequirementHistory(
				{ revisions: [...h.deposits].reverse().concat(h.deposits) },
				{ documentId: data.financial.id, currency: 'USD' }
			)
		).toBe(false);
		expect(
			isDepositRequirementHistory(null, { documentId: data.financial.id, currency: 'USD' })
		).toBe(false);
	});
});
