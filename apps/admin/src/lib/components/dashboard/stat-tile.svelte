<script lang="ts">
	import { Card } from '@fionas/ui';
	import type { StatTileView, StatTone } from '$lib/dashboard.js';
	let { stat }: { stat: StatTileView } = $props();
	const toneClass: Record<StatTone, string> = {
		olive: 'text-olive-700',
		'olive-soft': 'text-olive-500',
		moss: 'text-moss-600',
		rust: 'text-rust-600'
	};
</script>

<Card
	data-testid="summary-card"
	aria-label={`${stat.label}: ${stat.count}`}
	class="flex flex-col items-start gap-1 px-3.5 py-4"
>
	<span class={`font-sans text-[26px] leading-none font-bold ${toneClass[stat.tone]}`}
		>{stat.count}</span
	>
	<span
		class="font-sans text-[10px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-muted) uppercase"
		>{stat.label}</span
	>
</Card>
