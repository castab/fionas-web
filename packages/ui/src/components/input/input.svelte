<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../../utils.js';
	import { controlBase, focusRing } from '../../styles.js';

	let {
		ref = $bindable(null),
		value = $bindable(),
		type = 'text',
		class: className,
		...restProps
	}: WithElementRef<HTMLInputAttributes, HTMLInputElement> = $props();
</script>

<input
	bind:this={ref}
	bind:value
	{type}
	data-slot="input"
	class={cn(controlBase, focusRing, className)}
	{...restProps}
/>
