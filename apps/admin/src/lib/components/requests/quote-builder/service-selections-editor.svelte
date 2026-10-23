<script lang="ts">
	import { tick } from 'svelte';
	import type { SelectionDraft } from '$lib/quote-builder.js';
	import { MAX_SELECTIONS, selectionGroups } from '$lib/service-selections.js';
	import { fieldInput, fieldLabel, groupCaps, hint, lineTool } from './styles.js';
	let {
		items = $bindable(),
		errors = {},
		hydrated,
		changed,
		editing
	}: {
		items: SelectionDraft[];
		/** Field errors keyed `selection-<position>`, from local or server validation. */
		errors?: Record<string, string>;
		hydrated: boolean;
		/** An edit that should refresh the debounced preview. */
		changed: () => void;
		/** An edit in progress: the review is stale, but no preview runs yet. */
		editing: () => void;
	} = $props();
	const uid = $props.id();
	let root = $state<HTMLElement>();
	/** Expanded rows by editor identity; unset rows open only while blank or invalid. */
	let expanded = $state<Record<string, boolean>>({});
	const categories = $derived([...new Set(items.map((item) => item.group.trim()).filter(Boolean))]);
	const position = (rowId: string) => items.findIndex((row) => row.rowId === rowId);
	const isOpen = (item: SelectionDraft) =>
		expanded[item.rowId] ?? (!item.label.trim() || !!errors[`selection-${position(item.rowId)}`]);
	async function focus(selector: string) {
		await tick();
		root?.querySelector<HTMLElement>(selector)?.focus();
	}
	function act(kind: string, rowId = '') {
		if (!hydrated) return;
		const i = position(rowId);
		if (kind === 'add') {
			const row = { rowId: crypto.randomUUID(), label: '', group: '', key: null, sourceLabel: '' };
			items.push(row);
			expanded[row.rowId] = true;
			// A blank row is not part of the commitment yet; the preview follows its first edit.
			editing();
			void focus(`[name="selectionLabel:${row.rowId}"]`);
			return;
		}
		if (kind === 'remove') {
			items.splice(i, 1);
			void focus('[data-selection-add]');
		} else {
			const j = i + (kind === 'up' ? -1 : 1);
			if (j < 0 || j >= items.length) return;
			[items[i], items[j]] = [items[j], items[i]];
			const edge = kind === 'up' ? j === 0 : j === items.length - 1;
			void focus(`[data-selection-action="${edge ? 'remove' : kind}:${rowId}"]`);
		}
		changed();
	}
</script>

<div class="flex min-w-0 flex-col gap-3" data-testid="selection-editor" bind:this={root}>
	<div class="flex flex-col gap-1">
		<h4 class={groupCaps}>Selections</h4>
		<p class={hint}>
			Group selections under any category, or leave one uncategorized. Positions run across
			categories, so Move up and Move down change the overall order. Renaming a selection drops its
			link to the original pick.
		</p>
	</div>
	<!-- The overall order is serialized independently of the grouped presentation. -->
	{#each items as item (item.rowId)}<input
			type="hidden"
			name="selectionIdentity"
			value={item.rowId}
		/>{/each}
	<datalist id={`${uid}-categories`}>
		{#each categories as category (category)}<option value={category}></option>{/each}
	</datalist>
	{#each selectionGroups(items) as group, g (group.group)}
		<div class="flex min-w-0 flex-col gap-2">
			<h5 id={`${uid}-group-${g}`} class={`${groupCaps} wrap-anywhere`}>{group.heading}</h5>
			<ul class="m-0 flex list-none flex-col gap-2 p-0" aria-labelledby={`${uid}-group-${g}`}>
				{#each group.items as item (item.rowId)}
					{@const index = position(item.rowId)}
					{@const error = errors[`selection-${index}`]}
					<li
						class={[
							// Tools share the summary's line when there's room, and wrap below it on phones.
							'grid min-w-0 grid-cols-1 items-start gap-x-2 rounded-input border-[1.5px] bg-cream-200 px-3 py-1.5 sm:grid-cols-[minmax(0,1fr)_auto]',
							error ? 'border-rust-600' : 'border-transparent'
						]}
						data-testid="selection-row"
					>
						<input type="hidden" name={`selectionKey:${item.rowId}`} value={item.key ?? ''} />
						<input type="hidden" name={`selectionSource:${item.rowId}`} value={item.sourceLabel} />
						<details
							bind:open={() => isOpen(item), (open) => (expanded[item.rowId] = open)}
							class="group/selection"
						>
							<summary
								class="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-sm text-[13px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-olive-700 [&::-webkit-details-marker]:hidden"
							>
								<span class="w-5 shrink-0 text-[11px] text-(--text-muted) tabular-nums"
									>{index + 1}.</span
								>
								<span class="min-w-0 flex-1 wrap-anywhere"
									>{item.label.trim() || 'New selection'}</span
								>
								<span
									class="shrink-0 text-[11px] font-semibold text-olive-800 group-open/selection:hidden"
									>Edit<span class="sr-only"> selection {index + 1}</span></span
								>
								<span
									class="hidden shrink-0 text-[11px] font-semibold text-olive-800 group-open/selection:inline"
									>Done<span class="sr-only"> editing selection {index + 1}</span></span
								>
							</summary>
							<div class="grid min-w-0 grid-cols-1 gap-2.5 pt-1 pb-2 min-[480px]:grid-cols-2">
								<label class={fieldLabel}
									>Selection {index + 1} label<input
										class={`w-full font-normal ${fieldInput}`}
										name={`selectionLabel:${item.rowId}`}
										value={item.label}
										maxlength="200"
										aria-invalid={error ? 'true' : undefined}
										oninput={(e) => {
											item.label = e.currentTarget.value;
										}}
									/></label
								>
								<label class={fieldLabel}
									>Selection {index + 1} category<input
										class={`w-full font-normal ${fieldInput}`}
										name={`selectionGroup:${item.rowId}`}
										value={item.group}
										maxlength="120"
										list={`${uid}-categories`}
										placeholder="Optional"
										oninput={(e) => {
											// Regrouping waits for the change event so the row doesn't move mid-word.
											e.stopPropagation();
											editing();
										}}
										onchange={(e) => {
											item.group = e.currentTarget.value;
										}}
									/></label
								>
							</div>
						</details>
						<div
							class="flex flex-wrap gap-1 border-t border-(--border-soft) pt-1 sm:border-t-0 sm:pt-0"
						>
							{#each ['up', 'down', 'remove'] as kind (kind)}
								{@const name =
									kind === 'remove' ? 'Remove' : kind === 'up' ? 'Move up' : 'Move down'}
								<button
									class={[lineTool, kind === 'remove' && 'text-rust-600']}
									type={hydrated ? 'button' : 'submit'}
									name="selectionAction"
									value={`${kind}:${item.rowId}`}
									data-selection-action={`${kind}:${item.rowId}`}
									formnovalidate
									disabled={(kind === 'up' && index === 0) ||
										(kind === 'down' && index === items.length - 1)}
									aria-label={`${name} selection ${index + 1}, ${item.label.trim() || 'new selection'}`}
									onclick={() => act(kind, item.rowId)}>{name}</button
								>
							{/each}
						</div>
					</li>
				{/each}
			</ul>
		</div>
	{/each}
	{#if !items.length}<p class={hint}>
			No selections. You can still approve a service description on its own.
		</p>{/if}
	<button
		type={hydrated ? 'button' : 'submit'}
		name="selectionAction"
		value="add"
		data-selection-add
		formnovalidate
		disabled={items.length >= MAX_SELECTIONS}
		class={`${lineTool} self-start`}
		onclick={() => act('add')}>+ Add selection</button
	>
</div>
