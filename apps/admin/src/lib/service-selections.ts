import type { ServicePlanItem } from './quote-contract.js';

/** Limits from fionas-commerce's ServicePlanItem (PR #28). */
export const MAX_SELECTIONS = 50;
export const LABEL_MAX = 200;
export const GROUP_MAX = 120;
export const KEY_MAX = 120;
export const UNCATEGORIZED_HEADING = 'Other selections';

/** Presentation only: neither sorting nor deduplicating the source commitment. */
export function selectionGroups<T extends ServicePlanItem>(items: readonly T[]) {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const group = item.group?.trim() || '';
		const members = groups.get(group) ?? [];
		members.push(item);
		groups.set(group, members);
	}
	return [...groups].map(([group, items]) => ({
		group,
		heading: group || UNCATEGORIZED_HEADING,
		items
	}));
}

export function isServicePlanItem(value: unknown): value is ServicePlanItem {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const text = (v: unknown, max: number) => typeof v === 'string' && !!v.trim() && v.length <= max;
	return (
		'label' in value &&
		text(value.label, LABEL_MAX) &&
		(!('group' in value) || value.group == null || text(value.group, GROUP_MAX)) &&
		(!('key' in value) || value.key == null || text(value.key, KEY_MAX))
	);
}

/**
 * A customer's original pick, checked only for what rendering uses. The inquiry contract sets no
 * length or count limits, so a valid historical request is never refused for exceeding the plan's.
 */
export function isRequestedItem(value: unknown): value is ServicePlanItem {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const optional = (v: unknown) => v == null || typeof v === 'string';
	return (
		'label' in value &&
		typeof value.label === 'string' &&
		!!value.label.trim() &&
		(!('group' in value) || optional(value.group)) &&
		(!('key' in value) || optional(value.key))
	);
}

export function isServicePlanItems(value: unknown): value is ServicePlanItem[] {
	return Array.isArray(value) && value.length <= MAX_SELECTIONS && value.every(isServicePlanItem);
}

/** An editor row as posted: raw text plus the label it was copied from, if any. */
export type SelectionDraft = {
	/** Editor identity only; never sent to commerce and unrelated to `key`. */
	rowId: string;
	label: string;
	group: string;
	/** Opaque provenance of an original pick; null for custom selections. */
	key: string | null;
	/** The label the key belongs to; a different label is a substitution. */
	sourceLabel: string;
};

/** A row with no label, category or source is an unused placeholder, not a selection. */
export const isPlaceholder = (item: SelectionDraft) =>
	!item.label.trim() && !item.group.trim() && !item.key?.trim();

/** Trimmed, blank metadata as null, and no source key once the label was substituted. */
export function canonicalSelection(item: SelectionDraft): ServicePlanItem {
	const label = item.label.trim();
	return {
		label,
		group: item.group.trim() || null,
		key: label === item.sourceLabel.trim() ? item.key?.trim() || null : null
	};
}

export function selectionDrafts(items: readonly ServicePlanItem[]): SelectionDraft[] {
	return items.map((item, index) => ({
		rowId: `selection-${index}`,
		label: item.label,
		group: item.group ?? '',
		key: item.key ?? null,
		sourceLabel: item.label
	}));
}
