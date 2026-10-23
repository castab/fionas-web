<script lang="ts">
	import type { ServicePlanItem } from '$lib/quote-contract.js';
	import { selectionGroups } from '$lib/service-selections.js';
	let {
		items,
		headingLevel = 3,
		inset = false
	}: {
		items: readonly ServicePlanItem[];
		/** The heading level below the enclosing card or panel heading. */
		headingLevel?: 3 | 4;
		/** Chips on a cream-200 panel take the lighter field surface so they stay distinct. */
		inset?: boolean;
	} = $props();
	const uid = $props.id();
	const groups = $derived(selectionGroups(items));
</script>

{#if groups.length}
	<div class="flex min-w-0 flex-col gap-3" data-testid="categorized-selections">
		{#each groups as group, g (group.group)}
			<div class="flex min-w-0 flex-col gap-2">
				<svelte:element
					this={`h${headingLevel}`}
					id={`${uid}-${g}`}
					class="m-0 font-sans text-[10px] leading-[1.4] font-semibold tracking-(--track-caps-tight) wrap-anywhere text-(--text-muted) uppercase"
				>
					{group.heading}
				</svelte:element>
				<ul class="m-0 flex list-none flex-wrap gap-2 p-0" aria-labelledby={`${uid}-${g}`}>
					<!-- Labels and keys may repeat; position is the only safe identity. -->
					{#each group.items as item, i (i)}
						<li
							class={[
								'max-w-full rounded-full border-[1.5px] border-(--border-soft) px-3.5 py-[7px] text-[12.5px] font-medium wrap-anywhere',
								inset ? 'bg-[color-mix(in_srgb,var(--cream-100),white_55%)]' : 'bg-cream-200'
							]}
						>
							{item.label}
						</li>
					{/each}
				</ul>
			</div>
		{/each}
	</div>
{/if}
