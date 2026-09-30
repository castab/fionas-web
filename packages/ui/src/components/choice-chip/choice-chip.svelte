<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../../utils.js';

	/**
	 * A pill for picking from a short list (radio or checkbox). The native input fills the pill but
	 * is invisible, so it submits with the form, takes keyboard focus and receives the clicks.
	 */
	let {
		ref = $bindable(null),
		type = 'checkbox',
		label,
		meta,
		class: className,
		...restProps
	}: Omit<WithElementRef<HTMLInputAttributes, HTMLInputElement>, 'type' | 'children'> & {
		type?: 'radio' | 'checkbox';
		label: string;
		/** Short trailing note such as a price, e.g. "+$0.75/guest". */
		meta?: string;
	} = $props();
</script>

<label
	data-slot="choice-chip"
	class={cn(
		'relative inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-4 py-[9px]',
		'border-olive-300/70 bg-cream-100 font-sans text-xs leading-[1.4] font-semibold text-olive-900',
		'transition-[background-color,border-color,color] duration-(--dur-fast) ease-(--ease-out)',
		'hover:border-olive-500 has-checked:border-olive-700 has-checked:bg-olive-700 has-checked:text-cream-200',
		'has-focus-visible:outline-[3px] has-focus-visible:outline-offset-2 has-focus-visible:outline-(--focus-ring)',
		'has-disabled:cursor-not-allowed has-disabled:opacity-45 has-disabled:hover:border-olive-300/70',
		className
	)}
>
	<input
		bind:this={ref}
		{type}
		class="absolute inset-0 z-10 size-full cursor-[inherit] opacity-0"
		{...restProps}
	/>
	<span>{label}</span>
	{#if meta}<span class="font-medium opacity-75">· {meta}</span>{/if}
</label>
