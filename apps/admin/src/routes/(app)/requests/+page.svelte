<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button, Card, focusRing } from '@fionas/ui';
	import { site } from '@fionas/shared';
	import RequestRow from '$lib/components/request-list/request-row.svelte';
	import {
		REQUEST_FILTERS,
		SEARCH_MAX_LENGTH,
		clearSearchSearch,
		emptyListCopy,
		filterSearch,
		firstPageSearch,
		invalidListMessage,
		listSearch,
		nextPageSearch,
		requestFilterLabels,
		resultCountLabel,
		workspaceSearch
	} from '$lib/request-list.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const query = $derived(data.query);
	const list = $derived(data.list);
	const index = resolve('/(app)/requests');
	const workspace = (inquiryId: string) =>
		resolve('/(app)/requests/[inquiryId]', { inquiryId }) + workspaceSearch(query);
	const empty = $derived(list && list.rows.length === 0 ? emptyListCopy(query) : null);
	const caps =
		'font-sans text-[11px] leading-[1.4] font-semibold tracking-(--track-caps-tight) uppercase';
</script>

<svelte:head><title>Requests · Admin · {site.name}</title></svelte:head>

<div class="flex w-full max-w-[1040px] flex-col gap-5 pb-8">
	<header class="flex flex-col gap-1">
		<h1
			class="m-0 font-sans text-[1.75rem] leading-[1.2] font-bold tracking-(--track-heading) text-(--text-heading)"
		>
			Requests
		</h1>
		<p class="m-0 font-sans text-sm leading-[1.55] text-(--text-muted)">
			Every request, from first inquiry to closed or declined. Filter by status or search by
			customer, then open a request to work on it.
		</p>
	</header>

	{#if data.listError !== 'forbidden'}
		<!-- Plain links: each filter is its own URL; the search is kept and paging starts over. -->
		<nav aria-label="Request filters">
			<ul class="m-0 flex list-none flex-wrap gap-2 p-0">
				{#each REQUEST_FILTERS as filter (filter)}
					{@const current = filter === query.filter}
					<li>
						<!-- eslint-disable svelte/no-navigation-without-resolve -- the path is resolve()d; filterSearch builds its query -->
						<a
							href={index + filterSearch(query, filter)}
							aria-current={current ? 'page' : undefined}
							data-testid="request-filter"
							class={[
								'inline-flex min-h-11 items-center rounded-full border-[1.5px] px-4 py-2 font-sans text-[11px] leading-[1.4] font-semibold tracking-(--track-caps-tight) whitespace-nowrap uppercase no-underline transition-colors duration-(--dur-fast) ease-(--ease-out)',
								current
									? 'border-olive-700 bg-olive-700 text-cream-200 hover:text-cream-200'
									: 'border-(--border-soft) bg-(--surface-card) text-olive-800 hover:bg-cream-300/60 hover:text-olive-800',
								focusRing
							]}>{requestFilterLabels[filter]}</a
						>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					</li>
				{/each}
			</ul>
		</nav>

		<!-- A native GET form: it works without JavaScript, keeps the filter and drops the cursor. -->
		<form method="GET" action={index} role="search" class="flex flex-col gap-1.5">
			<label for="request-search" class={`text-(--text-heading) ${caps}`}>Search requests</label>
			<div class="flex flex-wrap items-center gap-2">
				{#if query.filter !== 'all'}<input type="hidden" name="filter" value={query.filter} />{/if}
				<input
					id="request-search"
					name="q"
					type="search"
					value={query.q}
					maxlength={SEARCH_MAX_LENGTH}
					autocomplete="off"
					spellcheck="false"
					enterkeyhint="search"
					aria-describedby="request-search-hint"
					placeholder="Customer name or email"
					class={`min-h-11 min-w-0 flex-[1_1_240px] rounded-input border border-olive-300/70 bg-cream-100 px-3.5 py-2.5 font-sans text-base leading-6 text-(--text-body) transition-[border-color,box-shadow] duration-(--dur-fast) ease-(--ease-out) placeholder:text-(--text-muted)/60 hover:border-olive-500 focus-visible:border-olive-700 ${focusRing}`}
				/>
				<Button type="submit" size="sm" class="min-h-11 flex-none px-5">Search</Button>
				{#if query.q}
					<Button
						href={index + clearSearchSearch(query)}
						variant="ghost"
						size="sm"
						class="min-h-11 flex-none">Clear search</Button
					>
				{/if}
			</div>
			<p id="request-search-hint" class="m-0 font-sans text-xs leading-[1.45] text-(--text-muted)">
				Matches part of a name or email, or an exact request ID.
			</p>
		</form>
	{/if}

	{#if list}
		<p
			class="m-0 font-sans text-sm leading-[1.55] font-semibold text-(--text-heading)"
			data-testid="request-count"
		>
			{resultCountLabel(list.totalCount, query.q)}
		</p>
		{#if empty}
			<Card
				variant="flat"
				class="flex flex-col items-start gap-3 px-5 py-5"
				data-testid="request-list-empty"
			>
				<p class="m-0 font-sans text-sm leading-[1.55] text-(--text-body)">{empty.message}</p>
				{#if empty.action}
					<Button href={index + empty.action.search} variant="secondary" size="sm"
						>{empty.action.label}</Button
					>
				{/if}
			</Card>
		{:else}
			<ul class="m-0 flex list-none flex-col gap-3 p-0" aria-label="Request results">
				{#each list.rows as row (row.id)}
					<li><RequestRow {row} href={workspace(row.id)} /></li>
				{/each}
			</ul>
		{/if}
		{#if query.cursor || list.nextCursor}
			<!-- Forward-only cursors: Next carries the backend's token; earlier pages are browser history. -->
			<nav aria-label="Pages" class="flex flex-wrap items-center gap-2.5">
				{#if query.cursor}
					<Button href={index + firstPageSearch(query)} variant="ghost" size="sm" class="min-h-11"
						>First page</Button
					>
				{/if}
				{#if list.nextCursor}
					<Button
						href={index + nextPageSearch(query, list.nextCursor)}
						variant="secondary"
						size="sm"
						class="ml-auto min-h-11"
						data-testid="next-page">Next page</Button
					>
				{/if}
			</nav>
		{/if}
	{:else}
		<Card class="flex flex-col items-start gap-4" role="alert" data-testid="request-list-error">
			<h2 class="m-0 text-(--text-heading) [font:var(--type-h2)]">
				{data.listError === 'forbidden'
					? 'Requests access unavailable'
					: data.listError === 'invalid'
						? 'These results can’t be shown'
						: 'Requests unavailable'}
			</h2>
			<p class="m-0 text-(--text-muted) [font:var(--type-body-sm)]">
				{data.listError === 'forbidden'
					? 'This account cannot view requests. Ask your administrator for access.'
					: data.listError === 'invalid' && data.recovery
						? invalidListMessage(data.recovery.reason)
						: 'We couldn’t load requests. Try again shortly.'}
			</p>
			{#if data.listError === 'invalid' && data.recovery}
				<Button href={index + data.recovery.search} size="sm">{data.recovery.label}</Button>
			{:else if data.listError === 'unavailable'}
				<Button href={index + listSearch(query)} data-sveltekit-reload size="sm">Try again</Button>
			{/if}
		</Card>
	{/if}
</div>
