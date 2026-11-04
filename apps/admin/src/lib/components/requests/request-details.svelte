<script lang="ts">
	import CategorizedSelections from './categorized-selections.svelte';
	import { Card, cn, focusRing } from '@fionas/ui';
	import type { InquiryResponse } from '$lib/request-contract.js';
	import { eventDateLabel, eventTypeLabel, guestCountLabel } from '$lib/presentation.js';
	import { receivedTimeLabel } from '$lib/payments.js';
	let {
		inquiry,
		approvedPlan = false,
		hideServed = false
	}: {
		inquiry: InquiryResponse;
		/** The picks always stay; with an approved plan they may differ from it, so they fold away. */
		approvedPlan?: boolean;
		/** Activity already shows when the event was served. */
		hideServed?: boolean;
	} = $props();
	const served = $derived(
		!hideServed &&
			inquiry.lifecycle.served &&
			Number.isFinite(Date.parse(inquiry.lifecycle.served.occurredAt))
			? inquiry.lifecycle.served.occurredAt
			: null
	);
	const caps =
		'm-0 font-sans text-[11px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-heading) uppercase';
	const micro =
		'm-0 font-sans text-[9.5px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-muted) uppercase';
	const value = 'm-0 mt-0.5 text-[13.5px] font-semibold';
</script>

<Card class="flex flex-col gap-3 p-[18px]" data-testid="event-card">
	<h2 class={caps}>Event</h2>
	<dl class="m-0 grid grid-cols-2 gap-x-4 gap-y-3">
		<div>
			<dt class={micro}>Date</dt>
			<dd class={value}>
				<time datetime={inquiry.eventDate}>{eventDateLabel(inquiry.eventDate)}</time>
			</dd>
		</div>
		<div>
			<dt class={micro}>Event type</dt>
			<dd class={value}>{eventTypeLabel(inquiry.eventType)}</dd>
		</div>
		<div>
			<dt class={micro}>Guests</dt>
			<dd class={value}>
				{guestCountLabel(
					inquiry.requestedService.guestCount,
					inquiry.requestedService.guestCountIsMinimum ?? false
				)}
			</dd>
		</div>
		<div>
			<dt class={micro}>Event ZIP</dt>
			<dd class={value}>{inquiry.zipCode}</dd>
		</div>
		{#if served}
			<div>
				<dt class={micro}>Marked served</dt>
				<dd class={value}><time datetime={served}>{receivedTimeLabel(served)}</time></dd>
			</div>
		{/if}
		<div>
			<dt class={micro}>Event contact</dt>
			<dd class="m-0 mt-0.5 text-[13.5px] text-(--text-muted)">Not on file</dd>
		</div>
		<div class={served ? 'col-span-2' : ''}>
			<dt class={micro}>Event location</dt>
			<dd class="m-0 mt-0.5 text-[13.5px] text-(--text-muted)">Not on file</dd>
		</div>
	</dl>
</Card>

<!-- The customer's own picks stay on the page at every stage. Before a plan is approved they are
     the brief, so they start open; afterwards they are reference, folded under the plan. -->
<Card class="p-0" data-testid="original-request">
	<details class="group" open={!approvedPlan}>
		<summary
			class={cn(
				'flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-card px-[18px] py-3.5 [&::-webkit-details-marker]:hidden',
				focusRing,
				'focus-visible:-outline-offset-3'
			)}
		>
			<h2 class={caps}>What they asked for</h2>
			<svg
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="1.75"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
				class="flex-none -rotate-90 text-(--text-muted) transition-transform duration-(--dur-fast) ease-(--ease-out) group-open:rotate-0"
				><path d="m6 9 6 6 6-6"></path></svg
			>
		</summary>
		<div class="flex flex-col gap-3 px-[18px] pb-[18px]">
			<p class="m-0 text-[11.5px] text-(--text-muted)">
				Recorded from the booking form, exactly as {inquiry.name} picked.{approvedPlan
					? ' The approved plan can differ from this; it stays here for reference.'
					: ''}
			</p>
			<CategorizedSelections items={inquiry.requestedService.items} />
			<div class="flex flex-col gap-1.5 border-t border-(--border-soft) pt-3">
				<h3 class={micro}>Their notes</h3>
				<p
					class="m-0 rounded-input bg-cream-200 px-3.5 py-3 text-[13.5px] leading-[1.6] wrap-anywhere whitespace-pre-line"
				>
					{inquiry.message || 'No additional message.'}
				</p>
			</div>
		</div>
	</details>
</Card>
