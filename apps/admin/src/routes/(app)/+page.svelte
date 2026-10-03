<script lang="ts">
	import { Badge } from '@fionas/ui';
	import { site } from '@fionas/shared';
	import { todayLine } from '$lib/dashboard.js';
	import { greetingName } from '$lib/staff.js';
	import DataPlaceholder from '$lib/components/dashboard/data-placeholder.svelte';
	import RequestGroup from '$lib/components/dashboard/request-group.svelte';
	import StatTile from '$lib/components/dashboard/stat-tile.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const dashboard = $derived(data.preview);
</script>

<svelte:head>
	<title>Dashboard · Admin · {site.name}</title>
</svelte:head>

<div class="flex flex-col gap-5.5 pb-8">
	<div class="flex flex-col gap-1">
		{#if dashboard}
			<Badge tone="outline" size="sm" class="mb-2 self-start">Sample data · preview only</Badge>
		{/if}
		<h1
			class="m-0 font-sans text-[1.75rem] leading-[1.2] font-bold tracking-(--track-heading) text-(--text-heading)"
		>
			hi, {greetingName(data.user)}
		</h1>
		<p class="m-0 font-sans text-[13.5px] leading-[1.55] text-(--text-muted)">
			{todayLine(data.todayLabel, dashboard?.waitingCount ?? null)}
		</p>
	</div>

	<div class="grid grid-cols-[repeat(auto-fit,minmax(118px,1fr))] gap-2.5">
		{#if dashboard}
			{#each dashboard.stats as stat (stat.label)}
				<StatTile {stat} />
			{/each}
		{:else}
			<DataPlaceholder
				class="col-span-full"
				title="New · Quoted · Booked · Needs closing"
				needs="each request's lifecycle status (new, quoted, booked, served) and its balance due, to count them."
			/>
		{/if}
	</div>

	<div class="flex flex-col gap-5.5">
		<h2
			class="m-0 font-sans text-xl leading-[1.3] font-bold tracking-[-0.01em] text-(--text-heading)"
		>
			waiting on you
		</h2>

		<RequestGroup title="Needs a reply" requests={dashboard?.replyGroup ?? null}>
			{#snippet placeholder()}
				<DataPlaceholder
					title="Unanswered messages"
					needs="a message thread per request (who sent the last message, and when), plus each request's estimate or quote total."
				/>
			{/snippet}
		</RequestGroup>

		<RequestGroup title="Needs a quote" requests={dashboard?.quoteGroup ?? null}>
			{#snippet placeholder()}
				<DataPlaceholder
					title="Requests without a quote"
					needs="which requests are still unquoted (a lifecycle status), with their estimate total and whether the guest count is a minimum."
				/>
			{/snippet}
		</RequestGroup>

		<RequestGroup title="Needs resolution" requests={dashboard?.resolutionGroup ?? null}>
			{#snippet placeholder()}
				<DataPlaceholder
					title="Expired quotes"
					needs="each quote's expiry date (or an expired status), so lapsed quotes can be found."
				/>
			{/snippet}
		</RequestGroup>
	</div>
</div>
