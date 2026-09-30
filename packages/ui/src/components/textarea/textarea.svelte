<script lang="ts">
	import type { HTMLTextareaAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../../utils.js';
	import { controlBase, focusRing } from '../../styles.js';

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		...restProps
	}: WithElementRef<HTMLTextareaAttributes, HTMLTextAreaElement> = $props();
</script>

<textarea
	bind:this={ref}
	bind:value
	data-slot="textarea"
	class={cn(controlBase, focusRing, 'min-h-22 resize-y', className)}
	{...restProps}></textarea>
