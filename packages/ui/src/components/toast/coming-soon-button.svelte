<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import { buttonVariants, type ButtonSize, type ButtonVariant } from '../button/index.js';
	import { cn, type WithoutChildren } from '../../utils.js';
	import {
		showComingSoonToast,
		type ComingSoonToastOptions
	} from './coming-soon-toast-state.svelte.js';

	/**
	 * A CTA for a feature that isn't live yet. It stays focusable and clickable but is marked
	 * aria-disabled, looks dimmed, and only raises the coming-soon toast — it never navigates
	 * or submits anything.
	 */
	let {
		toast,
		variant,
		size,
		class: className,
		children,
		...restProps
	}: WithoutChildren<Omit<HTMLButtonAttributes, 'type' | 'disabled' | 'onclick'>> & {
		toast: ComingSoonToastOptions;
		variant?: ButtonVariant;
		size?: ButtonSize;
		children: Snippet;
	} = $props();
</script>

<button
	type="button"
	data-slot="button"
	aria-disabled="true"
	onclick={() => showComingSoonToast(toast)}
	class={cn(
		buttonVariants({ variant, size }),
		'cursor-not-allowed opacity-50 active:translate-y-0',
		className
	)}
	{...restProps}
>
	{@render children()}
</button>
