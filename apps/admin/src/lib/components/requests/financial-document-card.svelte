<script lang="ts">
	import { Badge, Card } from '@fionas/ui';
	import type { CurrentStaffRequest } from '$lib/request-contract.js';
	import type { ServicePlanResponse } from '$lib/quote-contract.js';
	import { adjustmentKindLabel } from '$lib/quote-builder.js';
	import { formatMoney } from '$lib/presentation.js';
	import { financialStageLabel } from '$lib/request-workspace.js';
	let {
		financial,
		servicePlan = null
	}: {
		financial: CurrentStaffRequest['financial'];
		servicePlan?: ServicePlanResponse | null;
	} = $props();
	/** Why each line exists, from the plan approved with exactly this Quote version. */
	const provenance = $derived(
		new Map(
			servicePlan && servicePlan.documentVersion === financial.version
				? servicePlan.lines.flatMap((line) => {
						const note =
							line.origin.type === 'ADJUSTMENT'
								? `${adjustmentKindLabel(line.origin.kind)} · ${line.origin.reason}`
								: line.overrideReason
									? `Negotiated · ${line.overrideReason}`
									: null;
						return note ? [[line.lineItemId, note] as const] : [];
					})
				: []
		)
	);
	const stage = $derived(financialStageLabel(financial.stage));
	const caps =
		'm-0 font-sans text-[10px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-olive-800 uppercase';
</script>

<Card
	id="financial-document"
	class="flex flex-col gap-4 p-[18px] sm:p-5"
	data-testid="financial-document"
>
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h2 class={caps}>Serving plan</h2>
			<p class="m-0 mt-1 text-xs text-(--text-muted)">
				Current {stage.toLowerCase()} · Version {financial.version} · {financial.currency}
			</p>
		</div>
		<Badge tone="outline" size="sm">{stage}</Badge>
	</div>
	<ul class="m-0 flex list-none flex-col gap-4 p-0" aria-label="Financial line items">
		{#each financial.lines as line (line.id)}
			<li>
				<div class="flex items-baseline gap-2">
					<span class="min-w-0 text-sm font-semibold wrap-anywhere">{line.description}</span>
					<span
						aria-hidden="true"
						class="hidden min-w-2 flex-1 border-b-2 border-dotted border-olive-300 sm:block"
					></span>
					<span class="ml-auto max-w-[45%] text-right text-sm font-semibold wrap-anywhere"
						>{formatMoney(line.total, line.currency)}</span
					>
				</div>
				{#if line.subDescription}<p class="m-0 mt-1 text-xs wrap-anywhere text-(--text-muted)">
						{line.subDescription}
					</p>{/if}
				{#if provenance.get(line.id)}<p
						class="m-0 mt-1 text-xs font-semibold wrap-anywhere text-olive-800"
						data-testid="line-provenance"
					>
						{provenance.get(line.id)}
					</p>{/if}
				<p class="m-0 mt-1 text-xs wrap-anywhere text-(--text-muted)">
					{line.quantity !== undefined
						? `${line.quantity} × ${formatMoney(line.unitPrice, line.currency)}`
						: `Flat charge · ${formatMoney(line.unitPrice, line.currency)}`}
				</p>
			</li>
		{:else}
			<li class="text-sm text-(--text-muted)">No line items.</li>
		{/each}
	</ul>
	<dl class="m-0 flex flex-col gap-2 border-t border-(--border-soft) pt-3 text-sm">
		<div class="flex justify-between gap-4">
			<dt>Subtotal</dt>
			<dd class="m-0 text-right wrap-anywhere">
				{formatMoney(financial.subtotal, financial.currency)}
			</dd>
		</div>
		<div class="flex justify-between gap-4">
			<dt>Tax</dt>
			<dd class="m-0 text-right wrap-anywhere">
				{formatMoney(financial.taxAmount, financial.currency)}
			</dd>
		</div>
		<div class="mt-2 flex items-baseline justify-between gap-4 border-t-2 border-olive-700 pt-3">
			<dt class={caps}>{stage === 'Estimate' ? 'Estimated total' : 'Total'}</dt>
			<dd class="m-0 text-right text-xl font-bold wrap-anywhere text-(--text-heading)">
				{formatMoney(financial.total, financial.currency)}
			</dd>
		</div>
		<div class="flex justify-between gap-4 text-(--text-muted)">
			<dt>Current balance</dt>
			<dd class="m-0 text-right font-semibold wrap-anywhere">
				{formatMoney(financial.reconciliation.balance, financial.reconciliation.currency)}
			</dd>
		</div>
	</dl>
</Card>
