<script lang="ts">
	import { tick } from 'svelte';
	import { Button, focusRing } from '@fionas/ui';
	import type { SelectionDraft } from '$lib/quote-builder.js';
	import {
		GROUP_MAX,
		LABEL_MAX,
		MAX_SELECTIONS,
		UNCATEGORIZED_HEADING,
		selectionGroups
	} from '$lib/service-selections.js';
	import { fieldInput, fieldLabel, groupCaps, hint, lineTool } from './styles.js';
	let {
		items = $bindable(),
		errors = {},
		hydrated,
		changed
	}: {
		items: SelectionDraft[];
		/** Field errors keyed `selection-<position>`, from local or server validation. */
		errors?: Record<string, string>;
		hydrated: boolean;
		/** An edit that should refresh the debounced preview. */
		changed: () => void;
	} = $props();
	const uid = $props.id();
	let root = $state<HTMLElement>();
	/** The "+ Add selection" composer, with its label and category. */
	let composing = $state(false);
	let draftLabel = $state('');
	let draftGroup = $state('');
	/** The category whose inline chip input is open ('' is Other selections), if any. */
	let inlineGroup = $state<string | null>(null);
	let inlineLabel = $state('');
	let draftError = $state('');
	const categories = $derived([...new Set(items.map((item) => item.group.trim()).filter(Boolean))]);
	const position = (rowId: string) => items.findIndex((row) => row.rowId === rowId);
	const errorList = $derived(
		Object.entries(errors)
			.filter(([key]) => key.startsWith('selection-'))
			.map(([, message]) => message)
	);
	// Without JavaScript a blank or invalid row opens so it can be fixed in place.
	const isOpen = (item: SelectionDraft) =>
		!item.label.trim() || !!errors[`selection-${position(item.rowId)}`];
	const input = `w-full font-normal ${fieldInput}`;
	async function focus(selector: string) {
		await tick();
		root?.querySelector<HTMLElement>(selector)?.focus();
	}
	function remove(rowId: string) {
		items.splice(position(rowId), 1);
		changed();
		void focus('[data-selection-add]');
	}
	/** A typed category matches an existing one regardless of case; "Other selections" means none. */
	function resolveGroup(text: string) {
		const typed = text.trim();
		if (typed.toLowerCase() === UNCATEGORIZED_HEADING.toLowerCase()) return '';
		return categories.find((c) => c.toLowerCase() === typed.toLowerCase()) ?? typed;
	}
	const hasGroup = (group: string) => items.some((item) => item.group.trim() === group);
	const where = $derived.by(() => {
		const typed = draftGroup.trim();
		if (!typed) return `Leave the category blank to file it under ${UNCATEGORIZED_HEADING}.`;
		const group = resolveGroup(typed);
		return !group || categories.includes(group)
			? `Adds to ${group || UNCATEGORIZED_HEADING}.`
			: `Creates a new category, “${typed}”.`;
	});
	/** Adds a keyless selection; false (with a message) if it isn't valid. */
	function add(labelText: string, groupText: string) {
		const label = labelText.trim();
		const group = resolveGroup(groupText);
		if (!label) draftError = 'Name the selection first.';
		else if (label.length > LABEL_MAX)
			draftError = `Keep the selection to ${LABEL_MAX} characters.`;
		else if (group.length > GROUP_MAX) draftError = `Keep the category to ${GROUP_MAX} characters.`;
		else if (items.length >= MAX_SELECTIONS)
			draftError = `A serving plan lists at most ${MAX_SELECTIONS} selections.`;
		else {
			const row = { rowId: crypto.randomUUID(), label, group, key: null, sourceLabel: '' };
			// A new category goes before Other selections, which always stays last.
			const other = items.findIndex((item) => !item.group.trim());
			if (hasGroup(group) || other < 0) items.push(row);
			else items.splice(other, 0, row);
			draftError = '';
			changed();
			return true;
		}
		return false;
	}
	function commit() {
		// The composer stays open, keeping its category, so several picks can go in one by one.
		if (add(draftLabel, draftGroup)) draftLabel = '';
		void focus('[data-selection-draft]');
	}
	function commitInline() {
		if (add(inlineLabel, inlineGroup ?? '')) inlineLabel = '';
		void focus('[data-selection-inline]');
	}
	function closeComposer() {
		composing = false;
		draftLabel = '';
		draftGroup = '';
		draftError = '';
		void focus('[data-selection-add]');
	}
	function openComposer() {
		composing = true;
		inlineGroup = null;
		draftError = '';
		void focus('[data-selection-draft]');
	}
	/** The dashed "+" at the end of a category swaps for a chip-shaped input in that category. */
	function openInline(group: string) {
		inlineGroup = group;
		inlineLabel = '';
		composing = false;
		draftError = '';
		void focus('[data-selection-inline]');
	}
	function closeInline() {
		const group = inlineGroup;
		inlineGroup = null;
		inlineLabel = '';
		draftError = '';
		void focus(`[data-selection-quick="${CSS.escape(group ?? '')}"]`);
	}
	/** Enter adds and Escape cancels; neither may reach the quote form. */
	function onKey(e: KeyboardEvent, submit: () => void, cancel: () => void) {
		if (e.key === 'Enter') {
			e.preventDefault();
			submit();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			cancel();
		}
	}
</script>

<div class="flex min-w-0 flex-col gap-3" data-testid="selection-editor" bind:this={root}>
	<div class="flex flex-col gap-1">
		<h4 class={groupCaps}>Selections</h4>
		<p class={hint}>
			{#if hydrated}Selections are grouped under optional categories. Order doesn’t matter, since
				staff bring the quantity needed for the event. Remove a chip to drop it.{:else}Group
				selections under any category, or leave one uncategorized. Positions run across categories,
				so Move up and Move down change the overall order. Renaming a selection drops its link to
				the original pick.{/if}
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
			<ul
				class={[
					'm-0 list-none p-0',
					hydrated ? 'flex flex-row flex-wrap gap-2' : 'flex flex-col gap-2'
				]}
				aria-labelledby={`${uid}-group-${g}`}
			>
				{#each group.items as item (item.rowId)}
					{@const index = position(item.rowId)}
					{@const error = errors[`selection-${index}`]}
					{#if hydrated}
						<li
							class={[
								'inline-flex max-w-full items-center gap-1.5 rounded-full border bg-cream-200 py-1.5 pr-2 pl-3 text-[13px]',
								error ? 'border-rust-600' : 'border-olive-300'
							]}
							data-testid="selection-chip"
						>
							<input type="hidden" name={`selectionLabel:${item.rowId}`} value={item.label} />
							<input type="hidden" name={`selectionGroup:${item.rowId}`} value={item.group} />
							<input type="hidden" name={`selectionKey:${item.rowId}`} value={item.key ?? ''} />
							<input
								type="hidden"
								name={`selectionSource:${item.rowId}`}
								value={item.sourceLabel}
							/>
							<span class="min-w-0 wrap-anywhere">{item.label}</span>
							<button
								type="button"
								class={`grid size-6 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-base leading-none text-rust-600 transition-[background-color] duration-(--dur-fast) ease-(--ease-out) hover:bg-rust-600/10 ${focusRing}`}
								aria-label={`Remove ${item.label}`}
								onclick={() => remove(item.rowId)}><span aria-hidden="true">×</span></button
							>
						</li>
					{:else}
						<li
							class={[
								// Tools share the summary's line when there's room, and wrap below it on phones.
								'grid min-w-0 grid-cols-1 items-start gap-x-2 rounded-input border-[1.5px] bg-cream-200 px-3 py-1.5 sm:grid-cols-[minmax(0,1fr)_auto]',
								error ? 'border-rust-600' : 'border-transparent'
							]}
							data-testid="selection-row"
						>
							<input type="hidden" name={`selectionKey:${item.rowId}`} value={item.key ?? ''} />
							<input
								type="hidden"
								name={`selectionSource:${item.rowId}`}
								value={item.sourceLabel}
							/>
							<details open={isOpen(item)} class="group/selection">
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
											class={input}
											name={`selectionLabel:${item.rowId}`}
											value={item.label}
											maxlength="200"
											aria-invalid={error ? 'true' : undefined}
										/></label
									>
									<label class={fieldLabel}
										>Selection {index + 1} category<input
											class={input}
											name={`selectionGroup:${item.rowId}`}
											value={item.group}
											maxlength="120"
											list={`${uid}-categories`}
											placeholder="Optional"
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
										type="submit"
										name="selectionAction"
										value={`${kind}:${item.rowId}`}
										formnovalidate
										disabled={(kind === 'up' && index === 0) ||
											(kind === 'down' && index === items.length - 1)}
										aria-label={`${name} selection ${index + 1}, ${item.label.trim() || 'new selection'}`}
										>{name}</button
									>
								{/each}
							</div>
						</li>
					{/if}
				{/each}
				{#if hydrated}
					{#if inlineGroup === group.group}
						<li
							class="inline-flex items-center gap-1 rounded-full border-[1.5px] border-olive-700 bg-(--surface-card) py-[3px] pr-1 pl-3 shadow-[0_0_0_3px_var(--focus-ring)]"
						>
							<input
								class="min-h-7.5 w-37.5 min-w-0 border-0 bg-transparent p-0 font-sans text-[13px] leading-[1.4] text-(--text-body) outline-none"
								value={inlineLabel}
								maxlength="200"
								placeholder="New selection…"
								aria-label={`New selection in ${group.heading}`}
								aria-invalid={draftError ? 'true' : undefined}
								data-selection-inline
								oninput={(e) => {
									e.stopPropagation();
									inlineLabel = e.currentTarget.value;
									draftError = '';
								}}
								onchange={(e) => e.stopPropagation()}
								onkeydown={(e) => onKey(e, commitInline, closeInline)}
							/>
							<button
								type="button"
								class={`min-h-7.5 cursor-pointer rounded-full border-0 bg-olive-700 px-3 font-sans text-[10.5px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-cream-200 uppercase transition-[background-color] duration-(--dur-fast) ease-(--ease-out) not-disabled:hover:bg-olive-800 disabled:cursor-not-allowed disabled:opacity-45 ${focusRing}`}
								disabled={!inlineLabel.trim()}
								onclick={commitInline}>Add</button
							>
							<button
								type="button"
								class={`grid size-7 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-base leading-none text-(--text-muted) transition-[background-color] duration-(--dur-fast) ease-(--ease-out) hover:bg-cream-200 ${focusRing}`}
								aria-label={`Cancel adding to ${group.heading}`}
								onclick={closeInline}><span aria-hidden="true">×</span></button
							>
						</li>
					{:else}
						<li class="inline-flex">
							<button
								type="button"
								class={`inline-flex min-h-8.5 cursor-pointer items-center justify-center rounded-full border border-dashed border-olive-700 bg-transparent px-3.5 py-1.5 font-sans text-[13px] leading-[1.4] font-semibold text-olive-800 transition-[background-color] duration-(--dur-fast) ease-(--ease-out) not-disabled:hover:bg-cream-200 disabled:cursor-not-allowed disabled:opacity-45 ${focusRing}`}
								aria-label={`Add selection to ${group.heading}`}
								title="Add to this category"
								data-selection-quick={group.group}
								disabled={items.length >= MAX_SELECTIONS}
								onclick={() => openInline(group.group)}><span aria-hidden="true">+</span></button
							>
						</li>
					{/if}
				{/if}
			</ul>
		</div>
	{/each}
	{#if hydrated && inlineGroup !== null && draftError}<p
			role="alert"
			class="m-0 text-xs text-rust-600"
		>
			{draftError}
		</p>{/if}
	{#if hydrated && errorList.length}<p role="alert" class="m-0 text-xs text-rust-600">
			{errorList.join(' ')}
		</p>{/if}
	{#if !items.length}<p class={hint}>
			No selections. You can still approve a service description on its own.
		</p>{/if}
	{#if !hydrated}
		<button
			type="submit"
			name="selectionAction"
			value="add"
			data-selection-add
			formnovalidate
			disabled={items.length >= MAX_SELECTIONS}
			class={`${lineTool} self-start`}>+ Add selection</button
		>
	{:else if composing}
		<div
			role="group"
			aria-label="Add a selection"
			class="flex flex-wrap items-end gap-2.5 rounded-input border-[1.5px] border-olive-700 bg-(--surface-card) px-3.5 py-3 shadow-[0_0_0_3px_var(--focus-ring)]"
		>
			<label class={`${fieldLabel} flex-[1_1_180px]`}
				>Selection<input
					class={input}
					value={draftLabel}
					maxlength="200"
					placeholder="e.g. Birthday candles"
					aria-invalid={draftError ? 'true' : undefined}
					data-selection-draft
					oninput={(e) => {
						e.stopPropagation();
						draftLabel = e.currentTarget.value;
						draftError = '';
					}}
					onchange={(e) => e.stopPropagation()}
					onkeydown={(e) => onKey(e, commit, closeComposer)}
				/></label
			>
			<label class={`${fieldLabel} flex-[1_1_160px]`}
				><span
					>Category
					<span class="font-normal text-(--text-muted)">Optional — pick one or type a new one</span
					></span
				><input
					class={input}
					value={draftGroup}
					maxlength="120"
					list={`${uid}-categories`}
					placeholder={UNCATEGORIZED_HEADING}
					oninput={(e) => {
						e.stopPropagation();
						draftGroup = e.currentTarget.value;
						draftError = '';
					}}
					onchange={(e) => e.stopPropagation()}
					onkeydown={(e) => onKey(e, commit, closeComposer)}
				/></label
			>
			<div class="flex items-center gap-1.5">
				<Button
					type="button"
					class="min-h-11 px-4.5 py-2.5 text-[11px]"
					disabled={!draftLabel.trim()}
					onclick={commit}>Add</Button
				>
				<button type="button" class={lineTool} onclick={closeComposer}>Cancel</button>
			</div>
			<p class={`${hint} basis-full`} role={draftError ? 'alert' : 'status'}>
				{#if draftError}<span class="text-rust-600">{draftError}</span>{:else}{where}{/if}
			</p>
		</div>
	{:else}
		<button
			type="button"
			data-selection-add
			disabled={items.length >= MAX_SELECTIONS}
			class={`${lineTool} self-start`}
			onclick={openComposer}>+ Add selection</button
		>
	{/if}
</div>
