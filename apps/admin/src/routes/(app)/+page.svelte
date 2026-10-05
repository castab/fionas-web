<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button, Card } from '@fionas/ui';
	import { site } from '@fionas/shared';
	import { todayLine } from '$lib/dashboard.js';
	import { greetingName } from '$lib/staff.js';
	import RequestGroup from '$lib/components/dashboard/request-group.svelte';
	import StatTile from '$lib/components/dashboard/stat-tile.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const dashboard = $derived(data.dashboard);
</script>

<svelte:head><title>Dashboard · Admin · {site.name}</title></svelte:head>

<div class="flex flex-col gap-6 pb-8">
	<div class="flex flex-col gap-1">
		<h1
			class="m-0 font-sans text-[1.75rem] leading-[1.2] font-bold tracking-(--track-heading) text-(--text-heading)"
		>
			hi, {greetingName(data.user)}
		</h1>
		{#if dashboard}
			<p class="m-0 font-sans text-sm leading-[1.55] text-(--text-muted)">
				{todayLine(dashboard.dateLabel, dashboard.waitingCount)}
			</p>
		{/if}
	</div>
	{#if dashboard}
		<div class="grid grid-cols-2 gap-2.5 sm:grid-cols-4" aria-label="Request summary">
			{#each dashboard.stats as stat (stat.label)}<StatTile {stat} />{/each}
		</div>
		<div class="flex flex-col gap-6">
			<h2
				class="m-0 font-sans text-xl leading-[1.3] font-bold tracking-(--track-heading) text-(--text-heading)"
			>
				waiting on you
			</h2>
			<RequestGroup title="Needs a reply" requests={dashboard.replyGroup} />
			<RequestGroup title="Needs a quote" requests={dashboard.quoteGroup} />
			<RequestGroup title="Needs resolution" requests={dashboard.resolutionGroup} />
		</div>
	{:else}
		<Card class="flex flex-col items-start gap-4" role="alert">
			<h2 class="m-0 text-(--text-heading) [font:var(--type-h2)]">
				{data.dashboardError === 'forbidden'
					? 'Dashboard access unavailable'
					: 'Dashboard unavailable'}
			</h2>
			<p class="m-0 text-(--text-muted) [font:var(--type-body-sm)]">
				{data.dashboardError === 'forbidden'
					? 'This account cannot view the dashboard. Ask your administrator for access.'
					: 'We couldn’t load your dashboard. Try again shortly.'}
			</p>
			<Button href={resolve('/')} data-sveltekit-reload size="sm">Try again</Button>
		</Card>
	{/if}
</div>
