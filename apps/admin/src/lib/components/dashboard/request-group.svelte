<script lang="ts">
	import { capsXs } from '@fionas/ui';
	import type { RequestCardView } from '$lib/dashboard.js';
	import RequestCard from './request-card.svelte';
	let { title, requests }: { title: string; requests: RequestCardView[] } = $props();
</script>

<section class="flex flex-col gap-3" aria-label={title}>
	<h3 class={`m-0 text-(--text-heading) ${capsXs}`}>{title}</h3>
	{#if requests.length === 0}
		<p
			class="m-0 rounded-card border border-(--border-soft) px-4 py-4 font-sans text-[13px] leading-[1.55] text-(--text-muted)"
		>
			You’re caught up here.
		</p>
	{:else}
		<!-- Two cards across between 1150px and 1440px; one per row once the groups become columns. -->
		<ul
			class="m-0 grid list-none grid-cols-1 gap-3 p-0 min-[1150px]:grid-cols-2 min-[1440px]:grid-cols-1"
		>
			{#each requests as request (request.id)}
				<li class={requests.length === 1 ? 'min-[1150px]:col-span-2 min-[1440px]:col-span-1' : ''}>
					<RequestCard {request} />
				</li>
			{/each}
		</ul>
	{/if}
</section>
