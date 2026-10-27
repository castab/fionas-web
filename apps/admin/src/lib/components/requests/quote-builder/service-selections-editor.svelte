<script lang="ts">
	import { tick } from 'svelte';
	import { Button, focusRing } from '@fionas/ui';
	import type { SelectionDraft } from '$lib/quote-builder.js';
	import {
		GROUP_MAX,
		LABEL_MAX,
		MAX_SELECTIONS,
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
	let composing = $state(false);
	let draftLabel = $state('');
	let draftGroup = $state('');
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
	function commit() {
		const label = draftLabel.trim();
		const group = draftGroup.trim();
		if (!label) draftError = 'Name the selection first.';
		else if (label.length > LABEL_MAX)
			draftError = `Keep the selection to ${LABEL_MAX} characters.`;
		else if (group.length > GROUP_MAX) draftError = `Keep the category to ${GROUP_MAX} characters.`;
		else if (items.length >= MAX_SELECTIONS)
			draftError = `A serving plan lists at most ${MAX_SELECTIONS} selections.`;
		else {
			items.push({ rowId: crypto.randomUUID(), label, group, key: null, sourceLabel: '' });
			draftLabel = '';
			draftError = '';
			changed();
			void focus('[data-selection-draft]');
			return;
		}
		void focus('[data-selection-draft]');
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
		void focus('[data-selection-draft]');
	}
	/** Enter adds the selection; it must not submit the quote form. */
	function onEnter(e: KeyboardEvent) {
		if (e.key !== 'Enter') return;
		e.preventDefault();
		commit();
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
			</ul>
		</div>
	{/each}
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
			class="flex flex-col gap-2.5 rounded-input bg-cream-200 p-3.5"
		>
			<div class="grid grid-cols-1 gap-2.5 min-[480px]:grid-cols-2">
				<label class={fieldLabel}
					>Selection<input
						class={input}
						value={draftLabel}
						maxlength="200"
						placeholder="e.g. Rainbow Sprinkles"
						aria-invalid={draftError ? 'true' : undefined}
						data-selection-draft
						oninput={(e) => {
							e.stopPropagation();
							draftLabel = e.currentTarget.value;
							draftError = '';
						}}
						onchange={(e) => e.stopPropagation()}
						onkeydown={onEnter}
					/></label
				>
				<label class={fieldLabel}
					><span>Category <span class="font-normal text-(--text-muted)">Optional</span></span><input
						class={input}
						value={draftGroup}
						maxlength="120"
						list={`${uid}-categories`}
						placeholder="e.g. Toppings"
						oninput={(e) => {
							e.stopPropagation();
							draftGroup = e.currentTarget.value;
							draftError = '';
						}}
						onchange={(e) => e.stopPropagation()}
						onkeydown={onEnter}
					/></label
				>
			</div>
			{#if draftError}<p role="alert" class="m-0 text-xs text-rust-600">{draftError}</p>{/if}
			<div class="flex flex-wrap items-center gap-2">
				<Button
					type="button"
					variant="secondary"
					class="min-h-11 px-4.5 py-2.5 text-[11px]"
					onclick={commit}>Add</Button
				>
				<button type="button" class={lineTool} onclick={closeComposer}>Done</button>
			</div>
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
