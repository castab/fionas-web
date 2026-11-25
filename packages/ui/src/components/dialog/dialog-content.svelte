<script lang="ts">
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import CloseIcon from '../icons/close-icon.svelte';
	import { focusRing } from '../../styles.js';
	import { cn, type WithoutChildrenOrChild } from '../../utils.js';
	import Overlay from './dialog-overlay.svelte';

	/**
	 * shadcn-svelte dialog content: portalled, over a dimmed overlay, focus-trapped, closed by
	 * Escape, an outside click or the corner button. Restyled to brand tokens and faded in (no
	 * tw-animate-css).
	 */
	let {
		ref = $bindable(null),
		class: className,
		showCloseButton = true,
		closeLabel = 'Close',
		children,
		...restProps
	}: WithoutChildrenOrChild<DialogPrimitive.ContentProps> & {
		children?: Snippet;
		showCloseButton?: boolean;
		closeLabel?: string;
	} = $props();
</script>

<DialogPrimitive.Portal>
	<Overlay />
	<DialogPrimitive.Content
		bind:ref
		data-slot="dialog-content"
		class={cn(
			'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto',
			'rounded-card border border-(--border-soft) bg-(--surface-card) p-6 text-(--text-body) shadow-card outline-hidden',
			'transition-opacity duration-(--dur-med) ease-(--ease-out) starting:opacity-0',
			className
		)}
		{...restProps}
	>
		{@render children?.()}
		{#if showCloseButton}
			<DialogPrimitive.Close
				class={cn(
					'absolute top-3 right-3 inline-flex size-9 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-olive-800 transition-colors duration-(--dur-fast) ease-(--ease-out) hover:bg-olive-100',
					focusRing
				)}
			>
				<CloseIcon size={16} />
				<span class="sr-only">{closeLabel}</span>
			</DialogPrimitive.Close>
		{/if}
	</DialogPrimitive.Content>
</DialogPrimitive.Portal>
