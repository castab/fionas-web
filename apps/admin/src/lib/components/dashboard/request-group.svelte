<script lang="ts">
	import type { Snippet } from 'svelte';
	import { capsXs } from '@fionas/ui';
	import type { RequestCardView } from '$lib/dashboard.js';
	import RequestCard from './request-card.svelte';

	/** A titled group of request cards. Without `requests`, `placeholder` fills the slot. */
	let {
		title,
		requests,
		placeholder
	}: { title: string; requests: RequestCardView[] | null; placeholder?: Snippet } = $props();
</script>

<section class="flex flex-col gap-3" aria-label={title}>
	<h3 class={`m-0 text-(--text-heading) ${capsXs}`}>{title}</h3>
	{#if requests === null}
		{@render placeholder?.()}
	{:else if requests.length === 0}
		<p class="m-0 font-sans text-[13px] leading-[1.55] text-(--text-muted)">
			You’re caught up here.
		</p>
	{:else}
		<div class="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-3">
			{#each requests as request (request.id)}
				<RequestCard {request} />
			{/each}
		</div>
	{/if}
</section>
