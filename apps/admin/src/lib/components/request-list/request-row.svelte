<script lang="ts">
	import { Badge, focusRing } from '@fionas/ui';
	import type { RequestRowView } from '$lib/request-list.js';
	let { row, href }: { row: RequestRowView; href: string } = $props();
	const micro =
		'font-sans text-[9.5px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-muted) uppercase';
</script>

<!-- One native link per request: the whole row opens its workspace (no nested controls). -->
<!-- eslint-disable svelte/no-navigation-without-resolve -- callers pass a resolve()d workspace path with its return query -->
<a
	{href}
	data-testid="request-row"
	data-inquiry-id={row.id}
	class={`flex min-w-0 items-start gap-3.5 rounded-card bg-(--surface-card) px-4 py-3.5 text-(--text-body) no-underline shadow-card transition-colors duration-(--dur-fast) ease-(--ease-out) hover:bg-cream-100/80 hover:text-(--text-body) sm:items-center ${focusRing}`}
>
	<time
		datetime={row.eventDate}
		class="flex w-[58px] flex-none flex-col items-center justify-center rounded-input bg-olive-700 px-1.5 py-[7px] text-cream-200"
	>
		<span
			class="font-sans text-[9px] leading-[1.4] font-semibold tracking-(--track-caps-tight) uppercase"
			>{row.dateMonth}</span
		>
		<span class="font-sans text-lg leading-[1.1] font-bold">{row.dateDay}</span>
	</time>
	<div class="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
		<div class="flex min-w-0 flex-1 flex-col gap-1">
			<div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
				<p
					class="m-0 min-w-0 font-sans text-[14.5px] leading-[1.4] font-semibold wrap-anywhere text-(--text-body)"
					data-testid="request-row-name"
				>
					{row.name}
				</p>
				<!-- The actual stage, in words; color only reinforces it. -->
				<Badge tone={row.stageTone} size="sm" data-testid="request-row-stage"
					>{row.stageLabel}</Badge
				>
				{#if row.needsClosing}
					<Badge tone="outline" size="sm" data-testid="request-row-needs-closing"
						>Needs closing</Badge
					>
				{/if}
			</div>
			<p class="m-0 font-sans text-xs leading-[1.45] text-(--text-body)">{row.eventLabel}</p>
			<p class="m-0 font-sans text-xs leading-[1.45] wrap-anywhere text-(--text-muted)">
				<span>{row.email}</span>
				<span aria-hidden="true"> · </span>
				<span class="whitespace-nowrap">{row.submittedLabel}</span>
			</p>
		</div>
		<div
			class="flex min-w-0 flex-col gap-0.5 sm:max-w-[38%] sm:flex-none sm:items-end sm:text-right"
			data-testid="request-row-amount"
		>
			<span class={micro}>{row.totalCaption}</span>
			<span
				class="font-sans text-[15px] leading-[1.3] font-bold wrap-anywhere text-(--text-heading)"
				>{row.totalLabel}</span
			>
			{#if row.balanceLabel}
				<span class="font-sans text-[11.5px] leading-[1.4] wrap-anywhere text-(--text-muted)"
					>Balance {row.balanceLabel}</span
				>
			{/if}
		</div>
	</div>
</a>
<!-- eslint-enable svelte/no-navigation-without-resolve -->
