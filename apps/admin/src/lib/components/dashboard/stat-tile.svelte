<script lang="ts">
	import { focusRing } from '@fionas/ui';
	import type { StatTileView, StatTone } from '$lib/dashboard.js';

	let { stat }: { stat: StatTileView } = $props();

	const toneClass: Record<StatTone, string> = {
		olive: 'text-olive-700',
		'olive-soft': 'text-olive-500',
		moss: 'text-moss-600',
		rust: 'text-rust-600'
	};
</script>

<!-- Will open the request list filtered to this status; inert in the scaffold. -->
<button
	type="button"
	class={`flex cursor-pointer flex-col items-start gap-1 rounded-card border-0 bg-(--surface-card) px-3.5 py-4 text-left shadow-card transition-shadow duration-(--dur-fast) ease-(--ease-out) hover:shadow-raised ${focusRing}`}
>
	<span class={`font-sans text-[26px] leading-none font-bold ${toneClass[stat.tone]}`}>
		{stat.count}
	</span>
	<span
		class="font-sans text-[10px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-muted) uppercase"
	>
		{stat.label}
	</span>
</button>
