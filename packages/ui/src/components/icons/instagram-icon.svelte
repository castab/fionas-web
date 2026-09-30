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
	stroke-width="1.75"
	stroke-linecap="round"
	stroke-linejoin="round"
>
	<rect width="20" height="20" x="2" y="2" rx="5" />
	<path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
	<line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
</svg>
