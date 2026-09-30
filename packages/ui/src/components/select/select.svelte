<script lang="ts">
	import type { HTMLSelectAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../../utils.js';
	import { controlBase, focusRing } from '../../styles.js';

	/** Native `<select>` (best mobile + a11y behaviour) styled to match the other controls. */
	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLSelectAttributes, HTMLSelectElement> = $props();
</script>

<div class="relative">
	<select
		bind:this={ref}
		bind:value
		data-slot="select"
		class={cn(controlBase, focusRing, 'cursor-pointer appearance-none pr-11', className)}
		{...restProps}
	>
		{@render children?.()}
	</select>
	<svg
		aria-hidden="true"
		class="pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2 text-olive-700"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="1.75"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path d="m6 9 6 6 6-6" />
	</svg>
</div>
