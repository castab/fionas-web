<script lang="ts">
	import { Card, focusRing } from '@fionas/ui';
	import type { InquiryResponse } from '$lib/request-contract.js';
	import type { ServicePlanResponse } from '$lib/quote-contract.js';
	import { eventDateLabel, eventTypeLabel, guestCountLabel } from '$lib/presentation.js';
	let {
		inquiry,
		servicePlan = null
	}: { inquiry: InquiryResponse; servicePlan?: ServicePlanResponse | null } = $props();
	const caps =
		'm-0 font-sans text-[10px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-olive-800 uppercase';
</script>

<Card class="flex flex-col gap-4 p-[18px] sm:p-5" data-testid="event-card">
	<h2 class={caps}>Event</h2>
	<dl class="m-0 grid grid-cols-1 gap-x-6 gap-y-4 min-[440px]:grid-cols-2">
		<div>
			<dt class={caps}>Date</dt>
			<dd class="m-0 mt-1 font-sans text-sm font-semibold">
				<time datetime={inquiry.eventDate}>{eventDateLabel(inquiry.eventDate)}</time>
			</dd>
		</div>
		<div>
			<dt class={caps}>Event type</dt>
			<dd class="m-0 mt-1 text-sm font-semibold">{eventTypeLabel(inquiry.eventType)}</dd>
		</div>
		<div>
			<dt class={caps}>Guests</dt>
			<dd class="m-0 mt-1 text-sm font-semibold">
				{guestCountLabel(
					inquiry.requestedService.guestCount,
					inquiry.requestedService.guestCountIsMinimum ?? false
				)}
			</dd>
		</div>
		<div>
			<dt class={caps}>Event ZIP</dt>
			<dd class="m-0 mt-1 text-sm font-semibold">{inquiry.zipCode}</dd>
		</div>
		<div>
			<dt class={caps}>Event contact</dt>
			<dd class="m-0 mt-1 text-sm text-(--text-muted)">Collected when booking</dd>
		</div>
		<div class="min-[440px]:col-span-2">
			<dt class={caps}>Event location</dt>
			<dd class="m-0 mt-1 text-sm text-(--text-muted)">Collected when booking</dd>
		</div>
	</dl>
	<div class="border-t border-(--border-soft) pt-3">
		<a
			href={`mailto:${inquiry.email}`}
			class={`rounded-sm text-sm wrap-anywhere underline ${focusRing}`}>{inquiry.email}</a
		>
	</div>
</Card>

{#if servicePlan}
	<Card class="flex flex-col gap-4 p-5" data-testid="service-plan"
		><h2 class={caps}>What you’ll serve</h2>
		<p class="m-0 text-xs text-(--text-muted)">
			Approved with quote version {servicePlan.documentVersion}
		</p>
		<p class="m-0 text-sm whitespace-pre-wrap">{servicePlan.description}</p>
		{#if servicePlan.guestCount}<p class="m-0 text-sm">
				{servicePlan.guestCount} guests
			</p>{/if}
		<ul class="m-0 pl-5">
			{#each servicePlan.items as item, i (i)}<li>{item}</li>{/each}
		</ul></Card
	>
{/if}
<Card class="flex flex-col gap-4 p-5" data-testid="original-request"
	><h2 class={caps}>What {inquiry.name} asked for</h2>
	<ul class="m-0 pl-5">
		{#each inquiry.requestedService.items as item, i (i)}<li class="text-sm">
				{item.label}
			</li>{/each}
	</ul>
	<h3 class={caps}>Their notes</h3>
	<p class="m-0 text-sm whitespace-pre-wrap">{inquiry.message || 'No additional message.'}</p></Card
>
