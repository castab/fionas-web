<script lang="ts">
	import { Card, focusRing } from '@fionas/ui';
	import type { InquiryResponse } from '$lib/request-contract.js';
	import type { ServicePlanResponse } from '$lib/quote-contract.js';
	import {
		durationLabel,
		eventDateLabel,
		eventTypeLabel,
		guestCountLabel
	} from '$lib/presentation.js';
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
					inquiry.pricingInputs.guestCount,
					inquiry.pricingInputs.guestCountIsMinimum
				)}
			</dd>
		</div>
		<div>
			<dt class={caps}>Scooping time</dt>
			<dd class="m-0 mt-1 text-sm font-semibold">
				{durationLabel(inquiry.pricingInputs.durationMinutes)}
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
	<Card class="flex flex-col gap-4 p-[18px] sm:p-5" data-testid="service-plan">
		<div>
			<h2 class={caps}>What you’ll serve</h2>
			<p class="m-0 mt-1 text-xs text-(--text-muted)">
				Approved with quote version {servicePlan.documentVersion} · {guestCountLabel(
					servicePlan.service.guestCount,
					servicePlan.service.guestCountIsMinimum
				)} · {durationLabel(servicePlan.service.durationMinutes)}
			</p>
		</div>
		{#each servicePlan.service.selections as category (category.category)}
			<div>
				<h3 class={caps}>{category.displayName}</h3>
				<ul
					class="m-0 mt-2 flex list-none flex-wrap gap-2 p-0"
					aria-label={`${category.displayName} in the approved plan`}
				>
					{#each category.offerings as offering (offering.offering)}
						<li
							class="max-w-full rounded-full border-[1.5px] border-olive-300 bg-cream-200 px-3.5 py-[5px] text-xs font-semibold tracking-[0.05em] wrap-anywhere"
						>
							{offering.displayName}
						</li>
					{/each}
				</ul>
			</div>
		{/each}
	</Card>
{/if}

<Card class="flex flex-col gap-4 p-[18px] sm:p-5" data-testid="original-request">
	<div>
		<h2 class={caps}>What {inquiry.name} asked for</h2>
		<p class="m-0 mt-1 text-xs text-(--text-muted)">Their original request — as recorded.</p>
	</div>
	<details class="rounded-input bg-cream-200 p-3.5">
		<summary class={`cursor-pointer rounded-sm text-sm font-semibold ${focusRing}`}
			>Original selection details</summary
		>
		<div class="mt-3 flex flex-col gap-3">
			<p class="m-0 text-xs text-(--text-muted)">
				Recorded selection identifiers · Catalog revision {inquiry.pricingInputs.catalogRevision}
			</p>
			{#each inquiry.pricingInputs.selections as selection, index (index)}
				<div>
					<p class="m-0 text-xs font-semibold wrap-anywhere">
						Category identifier: <code>{selection.category}</code>
					</p>
					<ul
						class="m-0 mt-1 flex list-none flex-wrap gap-2 p-0"
						aria-label={`Offering identifiers for ${selection.category}`}
					>
						{#each selection.offerings as offering, index (index)}
							<li
								class="max-w-full rounded-sm border border-olive-300 px-2 py-1 text-xs wrap-anywhere"
							>
								<code>{offering}</code>
							</li>
						{/each}
					</ul>
				</div>
			{:else}
				<p class="m-0 text-sm text-(--text-muted)">No selection identifiers recorded.</p>
			{/each}
		</div>
	</details>
	<div class="border-t border-(--border-soft) pt-3">
		<h3 class={caps}>Their notes</h3>
		<p class="m-0 mt-2 text-sm wrap-anywhere whitespace-pre-wrap">
			{inquiry.message || 'No additional message.'}
		</p>
	</div>
</Card>
