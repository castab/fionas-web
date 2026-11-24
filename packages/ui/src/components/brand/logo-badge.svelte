<script lang="ts">
	import badgeUrl from '../../assets/logo-badge.svg';
	import { cn } from '../../utils.js';
	import type { HTMLImgAttributes } from 'svelte/elements';

	/** The stylized circular badge lockup: cream lettering baked onto an olive disc. */
	let {
		class: className,
		alt = "Fiona's Ice Cream",
		...restProps
	}: Omit<HTMLImgAttributes, 'src'> = $props();
</script>

<img
	src={badgeUrl}
	{alt}
	width="462"
	height="462"
	class={cn('block aspect-square rounded-full shadow-card', className)}
	{...restProps}
/>
