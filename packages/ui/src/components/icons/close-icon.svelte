<script lang="ts">
	let { size = 15 }: { size?: number } = $props();
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
	<path d="M18 6 6 18" />
	<path d="m6 6 12 12" />
</svg>
