<script lang="ts">
	import { resolve } from '$app/paths';
	import { cardVariants, cn, focusRing } from '@fionas/ui';
	import type { StatTileView, StatTone } from '$lib/dashboard.js';
	import { listSearch } from '$lib/request-list.js';
	let { stat }: { stat: StatTileView } = $props();
	const toneClass: Record<StatTone, string> = {
		olive: 'text-olive-700',
		'olive-soft': 'text-olive-500',
		moss: 'text-moss-600',
		rust: 'text-rust-600'
	};
</script>

<!-- The whole tile is one native link to the matching Requests view, even at zero. -->
<!-- eslint-disable svelte/no-navigation-without-resolve -- the path is resolve()d; listSearch builds its query -->
<a
	href={resolve('/(app)/requests') + listSearch({ filter: stat.filter })}
	data-testid="summary-card"
	aria-label={`${stat.label}: ${stat.count}. View ${stat.destination}`}
	class={cn(
		cardVariants({ variant: 'raised' }),
		'flex min-h-11 flex-col items-start gap-1 px-3.5 py-4 text-(--text-body) no-underline transition-colors duration-(--dur-fast) ease-(--ease-out) hover:bg-cream-100/80 hover:text-(--text-body)',
		focusRing
	)}
>
	<span class={`font-sans text-[26px] leading-none font-bold ${toneClass[stat.tone]}`}
		>{stat.count}</span
	>
	<span
		class="font-sans text-[10px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-muted) uppercase"
		>{stat.label}</span
	>
</a>
<!-- eslint-enable svelte/no-navigation-without-resolve -->
