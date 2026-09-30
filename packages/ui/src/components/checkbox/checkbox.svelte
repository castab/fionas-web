<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../../utils.js';
	import { focusRing, hintText } from '../../styles.js';

	/** A labelled native checkbox with an optional description line. */
	let {
		ref = $bindable(null),
		checked = $bindable(false),
		class: className,
		description,
		children,
		...restProps
	}: Omit<WithElementRef<HTMLInputAttributes, HTMLInputElement>, 'type' | 'children'> & {
		description?: string;
		children: Snippet;
	} = $props();
</script>

<label
	data-slot="checkbox"
	class={cn(
		'flex cursor-pointer items-start gap-3 has-disabled:cursor-not-allowed has-disabled:opacity-45',
		className
	)}
>
	<input
		bind:this={ref}
		bind:checked
		type="checkbox"
		class={cn(
			'mt-1 size-5 shrink-0 cursor-[inherit] rounded-sm accent-olive-700 aria-invalid:outline-2 aria-invalid:outline-rust-600',
			focusRing
		)}
		{...restProps}
	/>
	<span class="flex flex-col">
		<span class="text-(--text-body) [font:var(--type-body)]">{@render children()}</span>
		{#if description}
			<span class={hintText}>{description}</span>
		{/if}
	</span>
</label>
