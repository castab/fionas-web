<script lang="ts">
	import GalleryClient from './gallery-client.svelte';
	import { Button, InstagramIcon, capsSm, cn } from '@fionas/ui';
	import { site, instagramUrl } from '@fionas/shared';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
</script>

<main class="w-full flex-1">
	<section
		class="mx-auto flex max-w-[720px] flex-col items-center gap-4 px-5 pt-14 pb-10 text-center"
	>
		<span class={cn(capsSm, 'tracking-(--track-caps) text-olive-600')}>From the feed</span>
		<h1
			class="m-0 text-[40px] leading-[1.15] font-bold tracking-(--track-heading) text-balance text-(--text-heading)"
		>
			a few favorites from recent events
		</h1>
		<p class="m-0 max-w-[520px] text-[17px] leading-[1.65] text-(--text-muted)">
			A scoop of the good stuff from @{site.instagramHandle} — tap any photo or video to see it larger.
		</p>
		<Button
			href={instagramUrl}
			target="_blank"
			rel="noopener noreferrer"
			variant="secondary"
			class="min-h-12 hover:bg-cream-300"><InstagramIcon />Follow @{site.instagramHandle}</Button
		>
	</section>
	{#if data.firstPage.tiles.length > 0}
		<GalleryClient
			initialTiles={data.firstPage.tiles}
			initialHasNextPage={data.firstPage.hasNextPage}
			instagramHandle={site.instagramHandle}
		/>
	{:else}
		<section class="mx-auto max-w-[720px] px-5 pb-12 text-center">
			<p class="m-0 text-(--text-muted)">
				New photos and videos are on their way. Follow along on Instagram to see them first.
			</p>
		</section>
	{/if}
</main>
