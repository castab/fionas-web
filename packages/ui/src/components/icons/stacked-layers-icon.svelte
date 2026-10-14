<script lang="ts">
	/** Two overlapping rounded squares — marks a carousel (multi-image/video) post. */
	let { size = 18 }: { size?: number } = $props();
</script>

<svg
	aria-hidden="true"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.75"
	stroke-linecap="round"
	stroke-linejoin="round"
>
	<rect x="3" y="3" width="13" height="13" rx="2.5" />
	<path d="M8 21h10a2.5 2.5 0 002.5-2.5V8" />
</svg>
