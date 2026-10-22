<script lang="ts">
	import { Card } from '@fionas/ui';
	import type {
		CurrentStaffRequest,
		InquiryLifecycle,
		InquiryProposalResponse
	} from '$lib/request-contract.js';
	import type { ServicePlanResponse } from '$lib/quote-contract.js';
	import { formatMoney, submittedDateLabel } from '$lib/presentation.js';
	import { financialStageLabel } from '$lib/request-workspace.js';
	let {
		financial,
		stage: lifecycleStage,
		proposal = null,
		servicePlan = null
	}: {
		financial: CurrentStaffRequest['financial'];
		stage: InquiryLifecycle['stage'];
		proposal?: InquiryProposalResponse | null;
		servicePlan?: ServicePlanResponse | null;
	} = $props();
	/** Why each line exists, from the plan approved with exactly this Quote version. */
	const provenance = $derived(
		new Map(
			servicePlan && servicePlan.documentVersion === financial.version
				? servicePlan.lineNotes.map((line) => [line.lineItemId, line.note])
				: []
		)
	);
	const stage = $derived(financialStageLabel(financial.stage));
	const served = $derived(lifecycleStage === 'SERVED' || lifecycleStage === 'CLOSED');
	const issued = $derived(
		financial.stage === 'QUOTE' && proposal?.documentVersion === financial.version
			? ` · ${submittedDateLabel(proposal.issuedAt)}`
			: ''
	);
	const totalLabel = $derived(
		financial.stage === 'ESTIMATE'
			? 'Estimated total'
			: financial.stage === 'QUOTE'
				? 'Quote total'
				: 'Total'
	);
	const caps =
		'm-0 font-sans text-[11px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-heading) uppercase';
	const micro =
		'm-0 font-sans text-[9.5px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-muted) uppercase';
</script>

<Card
	id="financial-document"
	class="flex flex-col gap-3.5 p-[18px] sm:p-5"
	data-testid="financial-document"
>
	<div class="flex flex-wrap items-start justify-between gap-2.5">
		<div class="flex flex-col gap-1">
			<h2 class={caps}>Serving plan</h2>
			<p class="m-0 text-[11.5px] text-(--text-muted)">
				{lifecycleStage === 'DECLINED'
					? 'The Estimate on file when this request was declined. It was never quoted or invoiced.'
					: served
						? 'What you scooped and what you charged.'
						: 'What you’ll scoop and what you’re charging.'}
			</p>
		</div>
		<span
			class={`rounded-full border border-olive-300 px-2.5 py-1 whitespace-nowrap ${micro}`}
			data-testid="financial-version">{stage} v{financial.version}{issued}</span
		>
	</div>
	{#if servicePlan}
		<div class="flex flex-col gap-2 rounded-input bg-cream-200 p-3" data-testid="service-plan">
			<p class={micro}>
				{served ? 'What you served' : 'What you’ll serve'}{servicePlan.guestCount
					? ` · ${servicePlan.guestCount} guest${servicePlan.guestCount === 1 ? '' : 's'}`
					: ''}
			</p>
			<p class="m-0 text-[13px] leading-[1.6] whitespace-pre-wrap">{servicePlan.description}</p>
			{#if servicePlan.items.length}
				<p class="m-0 text-xs wrap-anywhere text-(--text-muted)">
					{servicePlan.items.join(' · ')}
				</p>
			{/if}
			<p class="m-0 text-[11px] text-(--text-muted)">
				Approved with Quote v{servicePlan.documentVersion}
			</p>
		</div>
	{/if}
	<ul class="m-0 flex list-none flex-col p-0" aria-label="Financial line items">
		{#each financial.lines as line (line.id)}
			{@const pricing =
				line.quantity !== undefined
					? `${line.quantity} × ${formatMoney(line.unitPrice, line.currency)}`
					: `Flat charge · ${formatMoney(line.unitPrice, line.currency)}`}
			{@const note = provenance.get(line.id)}
			<li class="flex items-baseline gap-3 border-b border-(--border-soft) py-2.5">
				<span class="flex min-w-0 flex-1 flex-col gap-0.5">
					<span class="text-[13.5px] font-semibold wrap-anywhere">{line.description}</span>
					{#if line.subDescription || note}
						<span class="text-[11.5px] wrap-anywhere text-(--text-muted)">
							{line.subDescription ?? ''}{line.subDescription && note ? ' · ' : ''}{#if note}<em
									data-testid="line-provenance">{note}</em
								>{/if}
						</span>
					{/if}
					<!-- Narrow screens keep the total on the right and show pricing under the name. -->
					<span class="text-[11.5px] text-(--text-muted) sm:hidden">{pricing}</span>
				</span>
				<span class="hidden text-xs whitespace-nowrap text-(--text-muted) sm:inline">{pricing}</span
				>
				<span
					class="min-w-20 text-right text-[13.5px] font-bold wrap-anywhere text-(--text-heading)"
					>{formatMoney(line.total, line.currency)}</span
				>
			</li>
		{:else}
			<li class="py-2.5 text-sm text-(--text-muted)">No line items.</li>
		{/each}
	</ul>
	<dl class="m-0 flex flex-col gap-1.5 text-[13px]">
		<div class="flex justify-between gap-4">
			<dt class="text-(--text-muted)">Subtotal</dt>
			<dd class="m-0 text-right wrap-anywhere">
				{formatMoney(financial.subtotal, financial.currency)}
			</dd>
		</div>
		<div class="flex justify-between gap-4">
			<dt class="text-(--text-muted)">Tax</dt>
			<dd class="m-0 text-right wrap-anywhere">
				{formatMoney(financial.taxAmount, financial.currency)}
			</dd>
		</div>
		<div
			class="flex justify-between gap-4 border-t border-(--border-soft) pt-2 text-[15px] font-bold text-(--text-heading)"
		>
			<dt>{totalLabel}</dt>
			<dd class="m-0 text-right wrap-anywhere">
				{formatMoney(financial.total, financial.currency)}
			</dd>
		</div>
		{#if financial.stage === 'INVOICE'}
			<div class="flex justify-between gap-4 font-semibold">
				<dt>Current balance</dt>
				<dd class="m-0 text-right wrap-anywhere">
					{formatMoney(financial.reconciliation.balance, financial.reconciliation.currency)}
				</dd>
			</div>
		{/if}
	</dl>
</Card>
