<script lang="ts">
	import { Badge, Card, capsSm, cn } from '@fionas/ui';
	import {
		completePricingInputs,
		computeAdvisoryEstimate,
		formatMoney,
		type InquiryAnswers,
		type InquiryForm
	} from '@fionas/shared';

	/**
	 * Price estimate, computed in the browser from the form's `pricingPreview` as soon as guests and
	 * service length are known, growing as choices are made. It is display only: nothing here is
	 * sent, and POST /inquiries prices the submitted selections on its own.
	 */
	let { form, answers }: { form: InquiryForm; answers: InquiryAnswers } = $props();

	const complete = $derived(completePricingInputs(form, answers) !== null);
	const estimate = $derived(computeAdvisoryEstimate(form, answers));
</script>

<Card class="flex flex-col gap-3 px-6 py-[22px]" aria-labelledby="estimate-heading">
	<div class="flex items-center justify-between gap-3">
		<h2 id="estimate-heading" class={cn(capsSm, 'm-0 text-(--text-heading)')}>
			{complete ? 'Your estimate' : 'Your estimate so far'}
		</h2>
		<Badge tone="outline" size="sm">Estimate only</Badge>
	</div>

	<div aria-live="polite" class="flex flex-col gap-3">
		{#if estimate}
			<ul class="m-0 flex list-none flex-col gap-2.5 p-0">
				{#each estimate.lines as line, i (i)}
					<li class="flex flex-col gap-0.5">
						<div class="flex items-baseline">
							<span class="text-[13px] leading-snug font-semibold text-(--text-body)">
								{line.description}
							</span>
							<span
								aria-hidden="true"
								class="mx-2 min-w-4 flex-1 border-b-2 border-dotted border-olive-300"
							></span>
							<span class="text-[13px] leading-snug font-semibold text-olive-900">
								{formatMoney(line.subtotal, line.currency)}
							</span>
						</div>
						{#if line.subDescription}
							<span class="text-[11.5px] leading-snug text-(--text-muted)">
								{line.subDescription}
							</span>
						{/if}
					</li>
				{/each}
			</ul>
			<div class="flex items-baseline justify-between gap-4 border-t-2 border-olive-700 pt-2.5">
				<span class={cn(capsSm, 'text-(--text-heading)')}
					>{estimate.guestCountIsMinimum ? 'Starting at' : 'Estimated total'}</span
				>
				<span class="text-xl leading-tight font-bold text-olive-900">
					{formatMoney(estimate.total, estimate.currency)}
				</span>
			</div>
		{:else}
			<p class="m-0 text-[12.5px] leading-snug text-(--text-muted)">
				Add your guest count and service length to start your estimate.
			</p>
		{/if}
	</div>

	<p class="m-0 text-[11.5px] leading-[1.55] text-(--text-muted)">
		This is an early estimate, not a final quote. Travel within greater Fresno and Madera Ranchos is
		included in the base service — bookings farther out may carry an added travel fee, confirmed
		once we chat. No street address needed yet.
	</p>
</Card>
