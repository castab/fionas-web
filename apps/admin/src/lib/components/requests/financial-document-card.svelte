<script lang="ts">
	import CategorizedSelections from './categorized-selections.svelte';
	import { Card } from '@fionas/ui';
	import type { CurrentStaffRequest } from '$lib/request-contract.js';
	import { approvalSource, serviceCommitment } from '$lib/service-plan.js';
	import { formatMoney, submittedDateLabel } from '$lib/presentation.js';
	import { financialStageLabel } from '$lib/request-workspace.js';
	let { request }: { request: CurrentStaffRequest } = $props();
	const financial = $derived(request.financial);
	const proposal = $derived(request.proposal ?? null);
	const lifecycleStage = $derived(request.inquiry.lifecycle.stage);
	/** The fulfillment commitment: the latest approval, which may be a deliberate clearing. */
	const commitment = $derived(serviceCommitment(request));
	/** The plan the deposit accepted, offered separately only when an amendment has moved on from it. */
	const accepted = $derived(
		request.acceptedServicePlan &&
			!request.acceptedServicePlan.cleared &&
			request.acceptedServicePlan.revision !== request.effectiveServicePlan?.revision
			? request.acceptedServicePlan
			: null
	);
	/** Why each line exists. Retained notes keep their stable line IDs across financial versions. */
	const provenance = $derived(
		new Map(
			commitment.state === 'APPROVED'
				? commitment.plan.lineNotes.map((line) => [line.lineItemId, line.note])
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
	const guests = (n?: number) => (n ? ` · ${n} guest${n === 1 ? '' : 's'}` : '');
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
	{#if commitment.state === 'APPROVED'}
		{@const plan = commitment.plan}
		<div class="flex flex-col gap-2 rounded-input bg-cream-200 p-3" data-testid="service-plan">
			<p class={micro}>
				{served ? 'What you served' : 'What you’ll serve'}{guests(plan.guestCount)}
			</p>
			<p class="m-0 text-[13px] leading-[1.6] whitespace-pre-wrap">{plan.description}</p>
			{#if plan.items.length}
				<CategorizedSelections items={plan.items} inset />
			{/if}
			<p class="m-0 text-[11px] text-(--text-muted)" data-testid="service-plan-provenance">
				Approved with {approvalSource(plan, request)} v{plan.documentVersion} · plan revision {plan.revision}
				· {submittedDateLabel(plan.approvedAt)}
			</p>
		</div>
	{:else if commitment.state === 'CLEARED'}
		<div
			class="flex flex-col gap-1 rounded-input bg-cream-200 p-3"
			data-testid="service-plan-cleared"
		>
			<p class={micro}>Service plan removed</p>
			<p class="m-0 text-[13px] leading-[1.6]">
				Staff removed the approved service plan. Nothing is currently committed.
			</p>
			<p class="m-0 text-[11px] text-(--text-muted)">
				Plan revision {commitment.plan.revision} · {submittedDateLabel(commitment.plan.approvedAt)}
			</p>
		</div>
	{/if}
	{#if accepted}
		<details class="rounded-input border border-(--border-soft) px-3" data-testid="accepted-plan">
			<summary class="min-h-11 cursor-pointer py-2.5 text-[12.5px] font-semibold"
				>Plan accepted with the deposit (revision {accepted.revision})</summary
			>
			<div class="flex flex-col gap-2 pb-3">
				<p class="m-0 text-[13px] leading-[1.6] whitespace-pre-wrap">
					{accepted.description}{guests(accepted.guestCount)}
				</p>
				{#if accepted.items.length}<CategorizedSelections
						items={accepted.items}
						headingLevel={4}
					/>{/if}
			</div>
		</details>
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
