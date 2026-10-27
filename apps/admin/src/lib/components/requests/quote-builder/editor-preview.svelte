<script lang="ts">
	import CategorizedSelections from '../categorized-selections.svelte';
	import { groupCaps, panelCaps } from './styles.js';
	import { changeLabel, decimalDifference } from '$lib/comparison.js';
	import { depositTermsLabel } from '$lib/deposit.js';
	import { editorCopy } from '$lib/financial-editor.js';
	import { formatMoney } from '$lib/presentation.js';
	import type { EditorPreview } from '$lib/quote-builder.js';
	import type { CurrentStaffRequest } from '$lib/request-contract.js';
	import type { QuotePreviewLine, ServicePlanPreview } from '$lib/quote-contract.js';
	import { serviceCommitment } from '$lib/service-plan.js';

	let { preview, request }: { preview: EditorPreview; request: CurrentStaffRequest } = $props();
	const copy = $derived(editorCopy[preview.mode]);
	const commitment = $derived(serviceCommitment(request));
	const row = 'flex justify-between gap-3';
	const label = 'text-(--text-muted)';

	/** Notes the current plan holds that the resulting plan no longer carries. */
	function removedNotes(resulting: ServicePlanPreview | null | undefined) {
		if (commitment.state !== 'APPROVED') return [];
		const kept = new Set((resulting?.lineNotes ?? []).map((n) => n.lineItemId));
		return commitment.plan.lineNotes.flatMap((n) => {
			const line = request.financial.lines.find((l) => l.id === n.lineItemId);
			return kept.has(n.lineItemId) || !line
				? []
				: [{ description: line.description, note: n.note }];
		});
	}
</script>

{#snippet lineList(lines: QuotePreviewLine[])}
	<ul class="m-0 flex list-none flex-col p-0 text-[13px]" aria-label="Previewed lines">
		{#each lines as line (line.id)}<li
				class="flex justify-between gap-3 border-b border-(--border-soft) py-[7px]"
			>
				<span class="min-w-0 wrap-anywhere"
					>{line.description}
					<span class="text-(--text-muted)"
						>· {line.quantity !== undefined
							? `${line.quantity} × ${formatMoney(line.unitPrice, line.currency)}`
							: 'flat'}{line.origin === 'NEW'
							? ' · new'
							: line.origin === 'REPLACED'
								? ' · changed'
								: ''}</span
					></span
				><span class="font-semibold whitespace-nowrap"
					>{formatMoney(line.total, line.currency)}</span
				>
			</li>{/each}
	</ul>
{/snippet}

{#snippet servicePlan(
	resulting: ServicePlanPreview | null | undefined,
	changed: boolean,
	testid: string
)}
	<div
		class="flex flex-col gap-2.5 border-b border-(--border-soft) pb-3"
		data-testid={testid}
		data-changed={changed}
	>
		<p class={groupCaps}>
			{changed ? 'Service plan · will change' : 'Service plan · unchanged'}{resulting?.guestCount
				? ` · ${resulting.guestCount} guest${resulting.guestCount === 1 ? '' : 's'}`
				: ''}
		</p>
		{#if resulting}
			<p class="m-0 text-[13px] leading-[1.6] wrap-anywhere whitespace-pre-wrap">
				{resulting.description}
			</p>
			<CategorizedSelections items={resulting.items} headingLevel={4} inset />
		{:else if changed}
			<p class="m-0 text-[13px] leading-[1.6]" data-testid="preview-plan-cleared">
				The service plan will be removed from this booking.
			</p>
		{:else}
			<p class="m-0 text-[13px] leading-[1.6] text-(--text-muted)">
				No service plan is approved for this booking.
			</p>
		{/if}
		{#if changed && removedNotes(resulting).length}
			<div role="note" class="text-[12.5px] leading-[1.55]" data-testid="preview-removed-notes">
				<p class="m-0 font-semibold">Service notes that will be removed</p>
				<ul class="m-0 mt-1 pl-5">
					{#each removedNotes(resulting) as note (note.description + note.note)}
						<li class="wrap-anywhere">{note.description}: {note.note}</li>
					{/each}
				</ul>
			</div>
		{/if}
	</div>
{/snippet}

{#snippet compare(rows: { name: string; value: string; testid: string; strong?: boolean }[])}
	<dl class="m-0 flex flex-col gap-1.5 text-[13px]">
		{#each rows as r (r.testid)}
			<div
				data-testid={r.testid}
				class={[
					row,
					r.strong &&
						'border-t border-(--border-soft) pt-2 text-[15px] font-bold text-(--text-heading)'
				]}
			>
				<dt class={r.strong ? '' : label}>{r.name}</dt>
				<dd class="m-0 text-right wrap-anywhere">{r.value}</dd>
			</div>
		{/each}
	</dl>
{/snippet}

{#snippet header(pill: string)}
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h3 class={panelCaps}>{copy.previewHeading}</h3>
		<span class={`rounded-full border border-olive-300 px-2.5 py-1 ${groupCaps}`}>{pill}</span>
	</div>
{/snippet}

<div
	aria-live="polite"
	class="flex flex-col gap-3 rounded-input bg-cream-200 p-3.5"
	data-testid="quote-preview"
	data-mode={preview.mode}
>
	{#if preview.mode === 'INITIAL_QUOTE'}
		{@const quote = preview.quote}
		{@render header(`Quote v${quote.quoteVersion} · ${copy.notYet}`)}
		{#if quote.servicePlan}<div
				class="flex flex-col gap-2.5 border-b border-(--border-soft) pb-3"
				data-testid="preview-service-plan"
			>
				<p class={groupCaps}>
					You’ll approve{quote.servicePlan.guestCount
						? ` · ${quote.servicePlan.guestCount} guest${quote.servicePlan.guestCount === 1 ? '' : 's'}`
						: ''}
				</p>
				<p class="m-0 text-[13px] leading-[1.6] wrap-anywhere whitespace-pre-wrap">
					{quote.servicePlan.description}
				</p>
				<CategorizedSelections items={quote.servicePlan.items} headingLevel={4} inset />
			</div>{/if}
		{@render lineList(quote.lines)}
		<dl class="m-0 flex flex-col gap-1.5 text-[13px]">
			<div class={row}>
				<dt class={label}>Subtotal</dt>
				<dd class="m-0">{formatMoney(quote.subtotal, quote.currency)}</dd>
			</div>
			<div class={row}>
				<dt class={label}>Tax</dt>
				<dd class="m-0">{formatMoney(quote.taxAmount, quote.currency)}</dd>
			</div>
			<div
				data-testid="quote-total"
				class="flex justify-between gap-3 border-t border-(--border-soft) pt-2 text-[15px] font-bold text-(--text-heading)"
			>
				<dt>Total</dt>
				<dd class="m-0">{formatMoney(quote.total, quote.currency)}</dd>
			</div>
			<div data-testid="quote-deposit" class="flex justify-between gap-3 font-semibold">
				<dt>Deposit to hold the date</dt>
				<dd class="m-0">{formatMoney(quote.deposit.requiredAmount.amount, quote.currency)}</dd>
			</div>
		</dl>
	{:else if preview.mode === 'QUOTE_REVISION'}
		{@const { quote, servicePlanChange, depositChange } = preview.revision}
		{@const current = request.depositRequirement}
		{@render header(
			quote.financialChange
				? `Quote v${quote.quoteVersion} · ${copy.notYet}`
				: `Quote v${quote.quoteVersion} stays · ${copy.notYet}`
		)}
		{#if !quote.financialChange}<p
				class="m-0 text-[12.5px] leading-[1.55]"
				data-testid="no-financial-change"
			>
				The pricing isn’t changing, so no new financial version is created. Publishing still
				replaces the offer {request.inquiry.name} would pay against.
			</p>{/if}
		{@render servicePlan(quote.servicePlan, servicePlanChange, 'preview-service-plan')}
		{@render lineList(quote.lines)}
		{@render compare([
			{
				name: 'Current total',
				value: formatMoney(quote.estimateTotal, quote.currency),
				testid: 'compare-current-total'
			},
			{
				name: 'Proposed total',
				value: formatMoney(quote.total, quote.currency),
				testid: 'quote-total'
			},
			{
				name: 'Difference',
				value: changeLabel(decimalDifference(quote.estimateTotal, quote.total), quote.currency),
				testid: 'compare-difference'
			},
			{
				name: 'Current deposit',
				value:
					current.state === 'ACTIVE'
						? `${formatMoney(current.requiredAmount.amount, current.requiredAmount.currency)} · ${depositTermsLabel(current.terms)}`
						: '—',
				testid: 'compare-current-deposit'
			},
			{
				name: depositChange ? 'Proposed deposit' : 'Deposit',
				value: `${formatMoney(quote.deposit.requiredAmount.amount, quote.currency)} · ${depositTermsLabel(quote.deposit.terms)}`,
				testid: 'quote-deposit',
				strong: true
			}
		])}
		<p class="m-0 text-xs text-(--text-muted)" data-testid="revision-effects">
			{depositChange
				? 'The deposit requirement will be approved again against this quote.'
				: 'The deposit terms are unchanged.'}
		</p>
	{:else}
		{@const invoice = preview.invoice}
		{@const settled = invoice.settlement}
		{@render header(
			invoice.financialChange
				? `Invoice v${invoice.resultingDocumentVersion} · ${copy.notYet}`
				: `Invoice v${invoice.reviewedDocumentVersion} stays · ${copy.notYet}`
		)}
		{#if !invoice.financialChange}<p
				class="m-0 text-[12.5px] leading-[1.55]"
				data-testid="no-financial-change"
			>
				The pricing isn’t changing, so no new invoice version is created. Only the service plan is
				amended.
			</p>{/if}
		{@render servicePlan(invoice.servicePlan, invoice.servicePlanChange, 'preview-service-plan')}
		{@render lineList(invoice.lines)}
		{@render compare([
			{
				name: 'Current invoice',
				value: formatMoney(invoice.currentTotal, invoice.currency),
				testid: 'compare-current-total'
			},
			{
				name: 'Revised invoice',
				value: formatMoney(invoice.total, invoice.currency),
				testid: 'quote-total'
			},
			{
				name: 'Change',
				value: changeLabel(
					decimalDifference(invoice.currentTotal, invoice.total),
					invoice.currency
				),
				testid: 'compare-difference'
			},
			{
				name: 'Already paid',
				value: formatMoney(invoice.netApplied, invoice.currency),
				testid: 'compare-paid'
			},
			{
				name: 'Remaining balance',
				value: formatMoney(invoice.balance, invoice.currency),
				testid: 'compare-balance',
				strong: true
			}
		])}
		<p class="m-0 text-xs leading-[1.55] text-(--text-muted)" data-testid="invoice-settlement">
			{settled === 'SETTLED'
				? 'Settled: the revised invoice is paid in full.'
				: settled === 'OVERPAID'
					? 'Overpaid: more has been paid than the revised invoice. Nothing is refunded automatically; any refund is a separate, explicit step.'
					: 'Balance due after this amendment.'}
			The accepted deposit stays as it was.
		</p>
	{/if}
</div>
