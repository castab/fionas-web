import { describe, expect, it } from 'vitest';
import {
	availableEditorMode,
	canAmendInvoice,
	canReviseQuote,
	editorActions,
	editorCopy,
	editorErrorMessage,
	editorPanels,
	editsDeposit,
	isNoMaterialChange,
	openEditorMode
} from './financial-editor.js';
import {
	INVOICE_AMENDMENT_PERMISSIONS,
	PROPOSAL_PERMISSIONS,
	hasInvoiceAmendmentPermissions
} from './request-workspace.js';
import { workspaceAction, workspaceSearch } from './request-list.js';
import { revisionFixture, type RevisionState } from '../../e2e/revision-fixture.mjs';

const quote = [...PROPOSAL_PERMISSIONS];
const invoice = [...INVOICE_AMENDMENT_PERMISSIONS];
const mode = (state: RevisionState, permissions = quote) =>
	availableEditorMode(revisionFixture(state), permissions);

describe('which editor a lifecycle offers', () => {
	it.each<[RevisionState, ReturnType<typeof mode>]>([
		['unquoted', 'INITIAL_QUOTE'],
		['quoted', 'QUOTE_REVISION'],
		['quote-financial-revision', 'QUOTE_REVISION'],
		['booked', 'INVOICE_AMENDMENT'],
		['booked-additional', 'INVOICE_AMENDMENT'],
		['overpaid', 'INVOICE_AMENDMENT'],
		['plan-cleared', 'INVOICE_AMENDMENT'],
		['served', 'INVOICE_AMENDMENT'],
		['closed', null],
		['declined', null]
	])('%s → %s', (state, expected) => {
		expect(mode(state)).toBe(expected);
	});
	it('offers nothing to a staff member without the matching authority', () => {
		expect(mode('unquoted', [])).toBeNull();
		expect(mode('quoted', invoice)).toBeNull();
		expect(
			mode(
				'booked',
				quote.filter((p) => p !== 'commerce.deposit-requirement.manage')
			)
		).toBe('INVOICE_AMENDMENT');
		expect(mode('booked', ['commerce.financial-document.create'])).toBeNull();
	});
	it('needs no deposit authority to amend an invoice, but does to revise a quote', () => {
		expect(hasInvoiceAmendmentPermissions(invoice)).toBe(true);
		expect(canAmendInvoice(revisionFixture('booked'), invoice)).toBe(true);
		expect(canReviseQuote(revisionFixture('quoted'), invoice)).toBe(false);
		expect(canReviseQuote(revisionFixture('quoted'), quote)).toBe(true);
	});
	it('never revises a quote whose deposit requirement is already met', () => {
		const data = revisionFixture('quoted');
		if (data.depositRequirement.state === 'ACTIVE') data.depositRequirement.satisfied = true;
		expect(canReviseQuote(data, quote)).toBe(false);
	});
	it('a malformed projection offers no editor', () => {
		const data = revisionFixture('booked');
		data.proposalHistory = [];
		expect(availableEditorMode(data, quote)).toBeNull();
	});
});

describe('panel flags resolve deterministically', () => {
	const flags = { INITIAL_QUOTE: true, QUOTE_REVISION: true, INVOICE_AMENDMENT: true };
	it.each<[RevisionState, ReturnType<typeof mode>]>([
		['unquoted', 'INITIAL_QUOTE'],
		['quoted', 'QUOTE_REVISION'],
		['booked', 'INVOICE_AMENDMENT'],
		['served', 'INVOICE_AMENDMENT'],
		['closed', null],
		['declined', null]
	])('with every flag set, %s opens only %s', (state, expected) => {
		expect(openEditorMode(revisionFixture(state), quote, flags)).toBe(expected);
	});
	it('a flag for a mode the lifecycle does not offer opens nothing', () => {
		expect(openEditorMode(revisionFixture('quoted'), quote, { INITIAL_QUOTE: true })).toBeNull();
		expect(openEditorMode(revisionFixture('booked'), quote, { QUOTE_REVISION: true })).toBeNull();
		expect(openEditorMode(revisionFixture('unquoted'), quote, {})).toBeNull();
		expect(openEditorMode(null, quote, flags)).toBeNull();
	});
	it('keeps one stable URL per editor and preserves the return context', () => {
		expect(editorPanels).toEqual({
			INITIAL_QUOTE: 'quote',
			QUOTE_REVISION: 'quote-revision',
			INVOICE_AMENDMENT: 'invoice-revision'
		});
		const from = { filter: 'quoted', q: 'maya' } as never;
		const action = workspaceAction(from, editorActions.QUOTE_REVISION.preview, 'quote-revision');
		expect(action.startsWith('?quote-revision&from=')).toBe(true);
		expect(action.endsWith('&/previewQuoteRevision')).toBe(true);
		expect(workspaceSearch(null, 'invoice-revision')).toBe('?invoice-revision');
		expect(workspaceSearch(null, 'history')).toBe('?history');
	});
});

describe('mode behavior', () => {
	it('only quotes edit a deposit', () => {
		expect(editsDeposit('INITIAL_QUOTE')).toBe(true);
		expect(editsDeposit('QUOTE_REVISION')).toBe(true);
		expect(editsDeposit('INVOICE_AMENDMENT')).toBe(false);
	});
	it('uses action-oriented labels that name what happens', () => {
		expect(editorCopy.INITIAL_QUOTE).toMatchObject({
			open: 'Build quote',
			previewHeading: 'Quote preview',
			publish: 'Issue quote'
		});
		expect(editorCopy.QUOTE_REVISION).toMatchObject({
			open: 'Revise quote',
			previewHeading: 'Revised quote preview',
			publish: 'Publish revised quote'
		});
		expect(editorCopy.INVOICE_AMENDMENT).toMatchObject({
			open: 'Amend invoice',
			previewHeading: 'Invoice amendment preview',
			publish: 'Approve invoice amendment'
		});
	});
});

describe('error language', () => {
	it('explains a no-op instead of treating it as a publication', () => {
		const message = editorErrorMessage('QUOTE_REVISION', 422, ['NO_MATERIAL_CHANGE']);
		expect(message).toBe(
			'Nothing has changed. Update the pricing or service details before publishing a new version.'
		);
		expect(isNoMaterialChange(['NO_MATERIAL_CHANGE'])).toBe(true);
		expect(isNoMaterialChange(['CURRENCY_MISMATCH'])).toBe(false);
	});
	it('names the problem for a removed noted line', () => {
		expect(editorErrorMessage('INVOICE_AMENDMENT', 422, ['SERVICE_PLAN_LINE_NOT_FOUND'])).toMatch(
			/service note/i
		);
	});
	it('asks for a reload on a conflict and on an unconfirmed publication', () => {
		expect(editorErrorMessage('INVOICE_AMENDMENT', 409)).toMatch(/reload/i);
		expect(editorErrorMessage('QUOTE_REVISION', 500, [], true)).toMatch(
			/couldn’t confirm.*reload/i
		);
		expect(editorErrorMessage('QUOTE_REVISION', 500, [], false)).toMatch(/nothing was changed/i);
	});
	it('leaks no diagnostics', () => {
		for (const status of [400, 403, 404, 409, 422, 500])
			expect(editorErrorMessage('INVOICE_AMENDMENT', status, [], true)).not.toMatch(/PRIVATE|http/);
	});
});
