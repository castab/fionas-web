import { describe, expect, it } from 'vitest';
import {
	canonicalSelection,
	isRequestedItem,
	isServicePlanItem,
	isServicePlanItems,
	selectionGroups
} from './service-selections.js';
import {
	initialQuoteValues,
	readQuoteForm,
	buildCommand,
	previewMatchesSelections,
	quoteInputErrors,
	type QuoteFormValues
} from './quote-builder.js';
import type { InquiryQuotePreviewResponse } from './quote-contract.js';
import { reviewFingerprint } from './server/quote-review.js';
import { requestFixtures, mayaId } from '../../e2e/request-fixture.mjs';

/** The quote form as a native browser posts it (financial lines omitted). */
function form(v: QuoteFormValues) {
	const f = new FormData();
	for (const [k, value] of Object.entries(v.deposit)) f.set(k, value);
	f.set('reviewedCurrency', 'USD');
	f.set('planDescription', v.description);
	f.set('planGuestCount', v.guestCount);
	f.set('reviewToken', v.reviewToken);
	f.set('reviewedFingerprint', v.reviewedFingerprint);
	for (const item of v.items) {
		f.append('selectionIdentity', item.rowId);
		for (const [k, value] of Object.entries({
			selectionLabel: item.label,
			selectionGroup: item.group,
			selectionKey: item.key ?? '',
			selectionSource: item.sourceLabel
		}))
			f.set(`${k}:${item.rowId}`, value);
	}
	return f;
}
const seed = () => initialQuoteValues(requestFixtures()[mayaId]);
const rowIds = (v: QuoteFormValues | null) => v?.items.map((i) => i.rowId);
const terms = { type: 'PERCENTAGE', percentage: '20' } as const;

describe('categorized presentation', () => {
	it('groups by first occurrence, keeps item order and duplicates, and never mutates', () => {
		const items = [
			{ label: 'B', group: 'Second', key: 'same' },
			{ label: 'A', group: 'First' },
			{ label: 'B', group: 'Second', key: 'same' },
			{ label: 'Custom' },
			{ label: 'Blank', group: '  ' },
			{ label: 'Null', group: null }
		];
		const before = structuredClone(items);
		const groups = selectionGroups(items);
		expect(groups.map((g) => g.heading)).toEqual(['Second', 'First', 'Other selections']);
		expect(groups[0].items).toEqual([items[0], items[2]]);
		expect(groups[2].items.map((i) => i.label)).toEqual(['Custom', 'Blank', 'Null']);
		expect(items).toEqual(before);
		expect(selectionGroups([])).toEqual([]);
	});

	it('uses arbitrary category text verbatim, without a known list or alphabetical sort', () => {
		const long = 'Zesty sorbets for the late-evening crowd, served from the second window ';
		const groups = selectionGroups([
			{ label: 'Lemon', group: long },
			{ label: 'Mango', group: 'Ålesund specials' },
			{ label: 'Lime', group: long }
		]);
		expect(groups.map((g) => g.group)).toEqual([long.trim(), 'Ålesund specials']);
		expect(groups[0].items.map((i) => i.label)).toEqual(['Lemon', 'Lime']);
	});

	it('groups the fixture’s interleaved categories in first-occurrence order', () => {
		const items = requestFixtures()[mayaId].inquiry.requestedService.items;
		expect(selectionGroups(items).map((g) => [g.heading, g.items.map((i) => i.label)])).toEqual([
			['Soft serve', ['Vanilla', 'Strawberry']],
			['Vessels', ['Waffle cones', 'Cups']],
			['Toppings', ['Rainbow sprinkles', 'Rainbow sprinkles']],
			['Other selections', ['Birthday candles']]
		]);
	});
});

describe('draft initialization', () => {
	it('copies complete original intent, in order, into an independent draft', () => {
		const data = requestFixtures()[mayaId];
		const before = structuredClone(data.inquiry.requestedService);
		const v = initialQuoteValues(data);
		expect(buildCommand(v).servicePlan?.items).toEqual(
			before.items.map((i) => ({ label: i.label, group: i.group ?? null, key: i.key ?? null }))
		);
		expect(new Set(rowIds(v)).size).toBe(v.items.length);
		expect(v.items.at(-1)).toMatchObject({ group: '', key: null });
		v.items[0].label = 'Custom';
		v.items[1].group = 'Changed';
		v.items.reverse();
		expect(data.inquiry.requestedService).toEqual(before);
	});
});

describe('structured command', () => {
	it('drops a substituted label’s source key, and restores it if the label is restored', () => {
		const v = seed();
		v.items[0].label = 'Birthday flavor';
		expect(buildCommand(v).servicePlan?.items?.[0]).toEqual({
			label: 'Birthday flavor',
			group: 'Soft serve',
			key: null
		});
		v.items[0].label = ' Vanilla ';
		expect(buildCommand(v).servicePlan?.items?.[0].key).toBe('vanilla');
	});

	it('canonicalizes whitespace and blank metadata, and never sends editor identities', () => {
		const v = seed();
		v.items[0].group = '';
		v.items[0].key = null;
		const before = buildCommand(v);
		v.items[0].rowId = 'another-row';
		v.items[0].label = ` ${v.items[0].label} `;
		v.items[0].sourceLabel = ` ${v.items[0].sourceLabel}`;
		v.items[0].group = ' ';
		v.items[0].key = ' ';
		expect(buildCommand(v)).toEqual(before);
		for (const item of before.servicePlan!.items!) {
			expect(Object.keys(item)).toEqual(['label', 'group', 'key']);
		}
	});

	it('keeps duplicate labels and keys as separate selections', () => {
		const items = buildCommand(seed()).servicePlan!.items!;
		expect(items.filter((i) => i.key === 'rainbow-sprinkles')).toHaveLength(2);
	});

	it('ignores an untouched placeholder but not a partly filled row', () => {
		const v = seed();
		v.items.push({ rowId: 'blank', label: ' ', group: '', key: null, sourceLabel: '' });
		expect(buildCommand(v)).toEqual(buildCommand(seed()));
		expect(quoteInputErrors(v)).toEqual({});
		v.items.at(-1)!.group = 'Toppings';
		expect(quoteInputErrors(v)).toHaveProperty('selection-7', expect.stringContaining('label'));
	});

	it('accepts zero, duplicate and category-free selections; refuses oversize text', () => {
		const v = seed();
		v.items = [];
		expect(quoteInputErrors(v)).toEqual({});
		expect(buildCommand(v).servicePlan?.items).toEqual([]);
		v.items = [
			{ rowId: 'a', label: 'x'.repeat(201), group: '', key: null, sourceLabel: '' },
			{ rowId: 'b', label: 'Custom', group: 'g'.repeat(121), key: null, sourceLabel: '' },
			{ rowId: 'c', label: 'Custom', group: '', key: null, sourceLabel: '' }
		];
		const errors = quoteInputErrors(v);
		expect(Object.keys(errors)).toEqual(['selection-0', 'selection-1']);
		expect(errors).not.toHaveProperty('line-0');
	});

	it('limits a plan to 50 selections', () => {
		const v = seed();
		v.items = Array.from({ length: 51 }, (_, i) => ({
			rowId: `r${i}`,
			label: 'Cup',
			group: '',
			key: null,
			sourceLabel: ''
		}));
		expect(quoteInputErrors(v)).toHaveProperty('selections');
	});
});

describe('review integrity', () => {
	it.each(['label', 'group', 'key', 'order', 'add', 'remove'])(
		'the fingerprint binds a selection %s change',
		(kind) => {
			const v = seed();
			const hash = () => reviewFingerprint(1, buildCommand(v), terms);
			const before = hash();
			if (kind === 'order') [v.items[0], v.items[1]] = [v.items[1], v.items[0]];
			else if (kind === 'remove') v.items.pop();
			else if (kind === 'add') v.items.push({ ...v.items[0], rowId: 'duplicate' });
			else if (kind === 'label') v.items[0].label = 'Changed';
			else v.items[0][kind as 'group' | 'key'] = 'Changed';
			expect(hash()).not.toBe(before);
		}
	);

	it('an unchanged command keeps its fingerprint across a native round trip', () => {
		const v = { ...seed(), lines: [] }; // `form` posts no financial lines
		const hash = (values: QuoteFormValues) => reviewFingerprint(1, buildCommand(values), terms);
		expect(hash(readQuoteForm(form(v))!)).toBe(hash(v));
	});

	it('a preview must show exactly the proposed selections', () => {
		const command = buildCommand(seed());
		const plan = command.servicePlan!;
		const preview = (items: unknown[]) =>
			({ servicePlan: { ...plan, items } }) as unknown as InquiryQuotePreviewResponse;
		expect(previewMatchesSelections(command, preview(plan.items!))).toBe(true);
		expect(previewMatchesSelections(command, preview([...plan.items!].reverse()))).toBe(false);
		expect(
			previewMatchesSelections(
				command,
				preview(plan.items!.map((i, n) => (n ? i : { ...i, group: 'Other' })))
			)
		).toBe(false);
		expect(
			previewMatchesSelections(command, {
				servicePlan: null
			} as unknown as InquiryQuotePreviewResponse)
		).toBe(false);
	});
});

describe('native form round trip', () => {
	it('reads every structured field as typed', () => {
		const v = seed();
		v.items[0].label = 'Vanilla ';
		expect(readQuoteForm(form(v))?.items).toEqual(v.items);
	});

	it('moves, removes and adds by row identity, preserving the rest of the draft', () => {
		const v = seed();
		v.description = 'Backyard service';
		const down = form(v);
		down.set('selectionAction', 'down:selection-0');
		const moved = readQuoteForm(down)!;
		expect(rowIds(moved)?.slice(0, 3)).toEqual(['selection-1', 'selection-0', 'selection-2']);
		expect(moved.description).toBe('Backyard service');
		const remove = form(moved);
		remove.set('selectionAction', 'remove:selection-1');
		expect(rowIds(readQuoteForm(remove))).toEqual(rowIds(v)?.filter((id) => id !== 'selection-1'));
		const add = form(v);
		add.set('selectionAction', 'add');
		const added = readQuoteForm(add)!;
		expect(added.items).toHaveLength(v.items.length + 1);
		expect(added.items.at(-1)).toMatchObject({ label: '', group: '', key: null });
		expect(new Set(rowIds(added)).size).toBe(added.items.length);
	});

	it.each([
		'missing',
		'duplicate',
		'unknown',
		'action',
		'unknown-row',
		'edge',
		'oversize',
		'multiple-action',
		'bad-id',
		'both-actions',
		'too-many',
		'add-at-limit'
	])('rejects a malformed selection envelope: %s', (kind) => {
		const v = seed();
		if (kind === 'too-many' || kind === 'add-at-limit')
			v.items = Array.from({ length: kind === 'too-many' ? 51 : 50 }, (_, i) => ({
				rowId: `r${i}`,
				label: 'Cup',
				group: '',
				key: null,
				sourceLabel: ''
			}));
		const f = form(v);
		if (kind === 'missing') f.delete('selectionGroup:selection-0');
		if (kind === 'duplicate') f.append('selectionIdentity', 'selection-0');
		if (kind === 'unknown') f.set('selectionAmount', '100');
		if (kind === 'action') f.set('selectionAction', 'up:selection-0:ignored');
		if (kind === 'unknown-row') f.set('selectionAction', 'remove:selection-99');
		if (kind === 'edge') f.set('selectionAction', 'up:selection-0');
		if (kind === 'oversize') f.set('selectionKey:selection-0', 'x'.repeat(121));
		if (kind === 'multiple-action') {
			f.append('selectionAction', 'add');
			f.append('selectionAction', 'add');
		}
		if (kind === 'bad-id') f.append('selectionIdentity', 'bad:id');
		if (kind === 'both-actions') {
			f.set('selectionAction', 'add');
			f.set('rowAction', 'remove:0');
		}
		if (kind === 'add-at-limit') f.set('selectionAction', 'add');
		expect(readQuoteForm(f)).toBeNull();
	});
});

describe('read-model guards', () => {
	it('accept canonical structured items and refuse legacy or malformed ones', () => {
		for (const bad of [
			'legacy',
			{},
			{ label: '' },
			{ label: ' ' },
			{ label: 'x'.repeat(201) },
			{ label: 'x', group: 5 },
			{ label: 'x', group: '' },
			{ label: 'x', key: 'x'.repeat(121) }
		])
			expect(isServicePlanItem(bad)).toBe(false);
		expect(isServicePlanItem({ label: 'Custom', group: null, key: null })).toBe(true);
		expect(isServicePlanItem({ label: 'Custom' })).toBe(true);
		expect(isServicePlanItems(['Churros'])).toBe(false);
		expect(isServicePlanItems(Array.from({ length: 51 }, () => ({ label: 'x' })))).toBe(false);
	});

	it('accept any well-typed original pick, since the inquiry contract sets no limits', () => {
		expect(isRequestedItem({ label: 'x'.repeat(500), group: 'g'.repeat(300) })).toBe(true);
		expect(isRequestedItem({ label: 'Vanilla', group: null, key: null })).toBe(true);
		for (const bad of ['Vanilla', { label: ' ' }, { label: 'x', key: 1 }])
			expect(isRequestedItem(bad)).toBe(false);
	});

	it('canonical selections satisfy the plan guard', () => {
		for (const item of seed().items) expect(isServicePlanItem(canonicalSelection(item))).toBe(true);
	});
});
