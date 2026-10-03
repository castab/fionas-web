<script lang="ts">
	import { focusRing } from '@fionas/ui';
	import type { RequestCardView } from '$lib/dashboard.js';

	let { request }: { request: RequestCardView } = $props();
</script>

<!-- Will open the request's detail; inert in the scaffold. -->
<button
	type="button"
	class={`flex w-full cursor-pointer items-center gap-3.5 rounded-card border-0 bg-(--surface-card) px-4 py-3.5 text-left shadow-card transition-shadow duration-(--dur-fast) ease-(--ease-out) hover:shadow-raised ${focusRing}`}
>
	<span
		class={[
			'flex min-w-[46px] flex-col items-center justify-center rounded-input px-1.5 py-[7px]',
			request.urgent ? 'bg-rust-600 text-cream-100' : 'bg-olive-700 text-cream-200'
		]}
	>
		<span
			class="font-sans text-[9px] leading-[1.4] font-semibold tracking-(--track-caps-tight) uppercase"
		>
			{request.dateMonth}
		</span>
		<span class="font-sans text-lg leading-[1.1] font-bold">{request.dateDay}</span>
	</span>
	<span class="flex min-w-0 flex-col gap-0.5">
		<span class="font-sans text-[14.5px] leading-[1.4] font-semibold text-(--text-body)">
			{request.name}
		</span>
		<span class="font-sans text-xs leading-[1.45] text-(--text-muted)">{request.waitMeta}</span>
	</span>
	{#if request.estLabel}
		<span
			class="ml-auto font-sans text-[13.5px] leading-[1.4] font-bold whitespace-nowrap text-(--text-heading)"
		>
			{request.estLabel}
		</span>
	{/if}
</button>
