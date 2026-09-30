<script lang="ts">
	import './layout.css';
	import { ComingSoonToast } from '@fionas/ui';
	import { site } from '@fionas/shared';
	import SiteHeader from '$lib/components/site-header.svelte';
	import SiteFooter from '$lib/components/site-footer.svelte';

	// Ice cream emoji as an SVG favicon — legible at tab size, unlike the badge logo.
	const favicon = `data:image/svg+xml,${encodeURIComponent(
		"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🍦</text></svg>"
	)}`;

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>{site.name}</title>
	<meta
		name="description"
		content="Soft serve & hand-scooped classics towed to your driveway, park, or backyard across Fresno & the Madera Ranchos."
	/>
</svelte:head>

<div class="flex min-h-dvh flex-col bg-(--surface-page)">
	<a
		class="fixed top-3 left-3 z-20 -translate-y-24 rounded-full bg-olive-700 px-4 py-3 text-cream-200 no-underline focus:translate-y-0"
		href="#main-content">Skip to content</a
	>
	<SiteHeader />
	<div id="main-content" class="flex flex-1 flex-col">
		{@render children()}
	</div>
	<SiteFooter />
</div>

<ComingSoonToast />
