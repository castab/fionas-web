<script lang="ts">
	import { Popover as PopoverPrimitive } from 'bits-ui';
	import { cn } from '../../utils.js';

	/** shadcn-svelte popover content, restyled to brand tokens and faded in (no tw-animate-css). */
	let {
		ref = $bindable(null),
		class: className,
		sideOffset = 6,
		align = 'center',
		collisionPadding = 16,
		...restProps
	}: PopoverPrimitive.ContentProps = $props();
</script>

<PopoverPrimitive.Portal>
	<PopoverPrimitive.Content
		bind:ref
		data-slot="popover-content"
		{sideOffset}
		{align}
		{collisionPadding}
		class={cn(
			'z-50 rounded-[10px] border border-(--border-soft) bg-popover px-3 py-2.5 text-ink-700 shadow-raised outline-hidden',
			'transition-opacity duration-(--dur-fast) ease-(--ease-out) starting:opacity-0',
			className
		)}
		{...restProps}
	/>
</PopoverPrimitive.Portal>
