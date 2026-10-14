<script lang="ts">
	let { size = 18 }: { size?: number } = $props();
</script>

<svg
	aria-hidden="true"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
>
	<path d="M11 5L6 9H3v6h3l5 4V5z" />
	<path d="M15.5 8.5a5 5 0 010 7M18.5 6a9 9 0 010 12" />
</svg>
