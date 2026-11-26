<script lang="ts">
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import { cn } from '../../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: DialogPrimitive.TitleProps = $props();
</script>

<DialogPrimitive.Title
	bind:ref
	data-slot="dialog-title"
	class={cn(
		'm-0 pr-8 font-sans text-lg leading-[1.3] font-bold tracking-(--track-heading) text-(--text-heading)',
		className
	)}
	{...restProps}
/>
