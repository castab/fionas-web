<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type { GalleryPage, GalleryTile } from '$lib/gallery.js';
	import { resolve } from '$app/paths';
	import { Button, cn, focusRing } from '@fionas/ui';
	import { PlayIcon, StackedLayersIcon } from '@fionas/ui';
	import LightboxCarousel from './lightbox-carousel.svelte';
	import { tileAlt, mediaTypeWord, truncateCaption } from './gallery-helpers.js';
	import { SvelteSet } from 'svelte/reactivity';

	let {
		initialTiles,
		initialHasNextPage,
		instagramHandle
	}: {
		initialTiles: GalleryTile[];
		initialHasNextPage: boolean;
		instagramHandle: string;
	} = $props();

	// Seeded once from the server-rendered first page, then diverges as loadMore() appends
	// pages — untrack() tells Svelte this one-time read is deliberate, not a missed binding.
	let tiles = $state(untrack(() => initialTiles));
	let hasNextPage = $state(untrack(() => initialHasNextPage));
	let isLoadingMore = $state(false);
	let loadMoreError = $state(false);
	let nextPage = 2;
	let endOfGalleryRef: HTMLParagraphElement | undefined = $state();
	let activeIndex = $state(-1);
	let muted = $state(true);
	let openingTile: HTMLButtonElement | null = null;
	let dialogRef: HTMLDivElement | undefined = $state();
	// SvelteSet, not `$state(new Set())`: $state only makes reassignment of the variable
	// reactive, not in-place mutation of a plain Set's internal slots — .add() calls on a
	// `$state`-wrapped Set silently don't trigger a re-render, leaving every `.has()` read
	// (e.g. the loading-spinner check below) permanently stuck at its first value.
	const loadedIds = new SvelteSet<string>();
	const loadedThumbnailIds = new SvelteSet<string>();
	const trackedViewIds = new SvelteSet<string>();
	const warmedMediaUrls = new SvelteSet<string>();
	let warmedMediaElements: HTMLImageElement[] = [];

	const hasActive = $derived(activeIndex > -1);
	const active = $derived(hasActive ? tiles[activeIndex] : null);

	async function trackView(id: string) {
		await fetch(resolve('/gallery/track'), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id, event: 'view' }),
			keepalive: true
		}).catch(() => {});
	}

	function trackClick(id: string) {
		void fetch(resolve('/gallery/track'), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id, event: 'click' }),
			keepalive: true
		}).catch(() => {});
	}

	async function loadMore() {
		isLoadingMore = true;
		loadMoreError = false;
		try {
			const response = await fetch(`${resolve('/gallery/load-more')}?page=${nextPage}`);
			if (!response.ok) throw new Error('Gallery request failed');
			const page: GalleryPage = await response.json();
			if (
				!Array.isArray(page.tiles) ||
				typeof page.hasNextPage !== 'boolean' ||
				page.currentPage !== nextPage
			) {
				throw new Error('Invalid gallery response');
			}
			tiles.push(...page.tiles);
			hasNextPage = page.hasNextPage;
			nextPage += 1;
			if (!page.hasNextPage) {
				await tick();
				endOfGalleryRef?.focus();
			}
		} catch {
			loadMoreError = true;
		} finally {
			isLoadingMore = false;
		}
	}

	function markLoaded(id: string) {
		loadedIds.add(id);
	}

	function markThumbnailLoaded(id: string) {
		loadedThumbnailIds.add(id);
	}

	function close() {
		activeIndex = -1;
		void tick().then(() => openingTile?.focus());
	}
	function prev() {
		activeIndex = (activeIndex - 1 + tiles.length) % tiles.length;
	}
	function next() {
		activeIndex = (activeIndex + 1) % tiles.length;
	}

	// This tile is server-rendered, so the browser can start (and finish) loading it before
	// hydration attaches onload below — in which case the load event already fired and would
	// otherwise never be seen, leaving the spinner stuck forever. `complete` catches that case
	// (also true after a failed load, which should stop the spinner too).
	function checkThumbnailComplete(node: HTMLImageElement, id: string) {
		if (node.complete) markThumbnailLoaded(id);
	}

	$effect(() => {
		if (!active || trackedViewIds.has(active.id)) return;
		trackedViewIds.add(active.id);
		void trackView(active.id);
	});

	// The lightbox deliberately renders just one post, so the browser otherwise has no reason
	// to request the large poster/photo for the post a visitor is most likely to view next.
	// Warm the entry slide for both adjacent posts while a post is open. Retaining these Image
	// objects matters because an unreferenced image may be collected and abort its request
	// before it reaches the cache.
	$effect(() => {
		if (!active || tiles.length < 2) return;

		const neighborIndices = [
			...new Set([
				(activeIndex - 1 + tiles.length) % tiles.length,
				(activeIndex + 1) % tiles.length
			])
		];
		for (const index of neighborIndices) {
			const item = tiles[index]?.mediaItems[0];
			if (!item) continue;

			const url = item.largeUrl;
			if (warmedMediaUrls.has(url)) continue;
			warmedMediaUrls.add(url);

			const image = new Image();
			image.decoding = 'async';
			image.src = item.largeUrl;
			warmedMediaElements.push(image);
		}
	});

	// Release our references after closing. Completed image responses remain in the browser
	// cache; an unfinished low-priority warm can be abandoned instead of outliving the dialog.
	$effect(() => {
		if (active) return;
		warmedMediaElements = [];
		warmedMediaUrls.clear();
	});
	$effect(() => {
		const dialog = dialogRef;
		if (!dialog || !active) return;
		void tick().then(() =>
			dialog.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.focus()
		);
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		function trapFocus(event: KeyboardEvent) {
			if (event.key !== 'Tab') return;
			const controls = Array.from(
				dialog!.querySelectorAll<HTMLElement>(
					'button:not(:disabled), a[href], input:not(:disabled)'
				)
			);
			const first = controls[0],
				last = controls.at(-1);
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		}
		dialog.addEventListener('keydown', trapFocus);
		return () => {
			document.body.style.overflow = previousOverflow;
			dialog.removeEventListener('keydown', trapFocus);
		};
	});
</script>

<section
	aria-label="Photos and videos"
	class="mx-auto grid max-w-(--container-max) grid-cols-[repeat(auto-fill,minmax(min(176px,calc(50%_-_6px)),1fr))] gap-3 px-5 pb-12"
>
	{#each tiles as tile, index (tile.id)}
		<button
			type="button"
			onclick={(event) => {
				openingTile = event.currentTarget;
				activeIndex = index;
			}}
			aria-label={`View ${mediaTypeWord(tile.mediaType)} ${index + 1} of ${tiles.length}: ${tileAlt(tile, instagramHandle)}`}
			class={cn(
				focusRing,
				'flex flex-col overflow-hidden rounded-card border border-(--border-soft) bg-(--surface-card) text-left shadow-raised transition-[transform,box-shadow] duration-(--dur-med) ease-out hover:-translate-y-0.5 hover:shadow-card'
			)}
		>
			<div class="relative aspect-square w-full overflow-hidden bg-(--paper-200)">
				<img
					use:checkThumbnailComplete={tile.id}
					src={tile.mediaItems[0].smallUrl}
					alt={tileAlt(tile, instagramHandle)}
					loading="lazy"
					decoding="async"
					onload={() => markThumbnailLoaded(tile.id)}
					onerror={() => markThumbnailLoaded(tile.id)}
					class="absolute inset-0 h-full w-full object-cover"
				/>
				{#if tile.mediaType === 'VIDEO' && loadedThumbnailIds.has(tile.id)}
					<div class="absolute inset-0 flex items-center justify-center text-cream-100">
						<span class="grid size-12 place-items-center rounded-full bg-ink-900/55"
							><PlayIcon size={20} /></span
						>
					</div>
				{/if}
				{#if tile.mediaType === 'CAROUSEL_ALBUM' && loadedThumbnailIds.has(tile.id)}
					<div
						class="absolute top-2 right-2 grid size-[30px] place-items-center rounded-full bg-ink-900/55 text-cream-100"
					>
						<StackedLayersIcon size={18} />
					</div>
				{/if}
				{#if !loadedThumbnailIds.has(tile.id)}
					<div class="absolute inset-0 flex items-center justify-center bg-(--paper-200)">
						<div
							role="status"
							class="size-8 animate-spin rounded-full border-[3px] border-(--olive-700)/25 border-t-(--olive-700) motion-safe:animate-spin"
						>
							<span class="sr-only">
								Loading {tile.mediaType === 'VIDEO' ? 'video' : 'photo'}…
							</span>
						</div>
					</div>
				{/if}
			</div>
			<p class="m-0 px-4 py-3 text-sm leading-[1.6] text-(--text-muted)">
				{tile.caption ? truncateCaption(tile.caption) : `A moment from @${instagramHandle}`}
			</p>
		</button>
	{/each}
</section>

<div class="mx-auto flex max-w-(--container-max) justify-center px-5 pb-18">
	{#if hasNextPage}
		<div class="flex flex-col items-center gap-3">
			<Button variant="secondary" onclick={() => void loadMore()} disabled={isLoadingMore}>
				{isLoadingMore ? 'Loading…' : 'Load more'}
			</Button>
			{#if loadMoreError}
				<p role="alert" class="m-0 text-sm text-(--rust-600)">
					Couldn't load more photos. Please try again.
				</p>
			{/if}
		</div>
	{:else}
		<p
			bind:this={endOfGalleryRef}
			tabindex="-1"
			role="status"
			class="m-0 text-sm text-(--text-muted) focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring) focus-visible:outline-solid"
		>
			You're all caught up.
		</p>
	{/if}
</div>

{#if active}
	{#key active.id}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_interactive_supports_focus -->
		<div
			bind:this={dialogRef}
			role="dialog"
			aria-modal="true"
			aria-label={tileAlt(active, instagramHandle)}
			class="fixed inset-0 z-[1000] flex items-center justify-center bg-(--ink-900)/65 p-5"
			onclick={close}
		>
			<LightboxCarousel
				tile={active}
				{instagramHandle}
				{muted}
				onToggleMute={() => (muted = !muted)}
				{loadedIds}
				{markLoaded}
				onClose={close}
				onPrev={prev}
				onNext={next}
				onLinkClick={() => trackClick(active.id)}
			/>
		</div>
	{/key}
{/if}
