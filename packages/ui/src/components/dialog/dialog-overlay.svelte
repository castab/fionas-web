<script lang="ts">
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import { cn } from '../../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: DialogPrimitive.OverlayProps = $props();
</script>

<DialogPrimitive.Overlay
	bind:ref
	data-slot="dialog-overlay"
	class={cn(
		'fixed inset-0 z-50 bg-ink-900/40',
		'transition-opacity duration-(--dur-fast) ease-(--ease-out) starting:opacity-0',
		className
	)}
	{...restProps}
/>
