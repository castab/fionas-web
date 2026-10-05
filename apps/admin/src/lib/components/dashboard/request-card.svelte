<script lang="ts">
	import { Card } from '@fionas/ui';
	import type { RequestCardView } from '$lib/dashboard.js';
	let { request }: { request: RequestCardView } = $props();
</script>

<Card data-testid="request-card" class="flex min-w-0 items-center gap-3.5 px-4 py-3.5">
	<time
		datetime={request.eventDate}
		class={[
			'flex w-[58px] flex-none flex-col items-center justify-center rounded-input px-1.5 py-[7px]',
			request.urgent ? 'bg-rust-600 text-cream-100' : 'bg-olive-700 text-cream-200'
		]}
	>
		<span
			class="font-sans text-[9px] leading-[1.4] font-semibold tracking-(--track-caps-tight) uppercase"
			>{request.dateMonth}</span
		>
		<span class="font-sans text-lg leading-[1.1] font-bold">{request.dateDay}</span>
	</time>
	<div class="flex min-w-0 flex-1 flex-col gap-0.5">
		<p
			class="m-0 font-sans text-[14.5px] leading-[1.4] font-semibold wrap-anywhere text-(--text-body)"
		>
			{request.name}
		</p>
		<p class="m-0 font-sans text-xs leading-[1.45] text-(--text-muted)">{request.waitMeta}</p>
	</div>
	<p
		class="m-0 max-w-[40%] font-sans text-[13.5px] leading-[1.4] font-bold wrap-anywhere text-(--text-heading)"
	>
		{request.estLabel}
	</p>
</Card>
