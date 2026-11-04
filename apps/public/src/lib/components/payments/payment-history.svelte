<script lang="ts">
	import { Card, capsSm, cn, hintText } from '@fionas/ui';
	import type { PaymentReceipt } from '$lib/payments/contract.js';
	import { decimalToCents, formatCents, formatDecimal } from '$lib/payments/money.js';
	import { receivedDateLabel } from '$lib/payments/view.js';

	/** Customer-safe receipts exactly as commerce lists them; no receipts or PDFs are implied. */
	let { history }: { history: PaymentReceipt[] } = $props();
</script>

<Card
	variant="flat"
	class="flex flex-col gap-3 px-[26px] py-5 max-[600px]:px-5"
	data-testid="payment-history"
>
	<h2 class={cn(capsSm, 'm-0 text-(--text-heading)')}>Payment history</h2>
	{#if history.length === 0}
		<p class="m-0 text-(--text-muted) [font:var(--type-body-sm)]">No payments yet.</p>
	{:else}
		<ul class="m-0 flex list-none flex-col p-0">
			{#each history as receipt, i (i)}
				{@const refunded = decimalToCents(receipt.refundedAmount)}
				<li
					class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-t border-(--border-soft) py-3 first:border-t-0 first:pt-0 last:pb-0"
				>
					<span class="font-sans text-[14px] text-(--text-body)">
						<time datetime={receipt.receivedAt}>{receivedDateLabel(receipt.receivedAt)}</time>
					</span>
					<span class="flex flex-col items-end">
						<span class="font-sans text-[14px] font-semibold text-(--text-heading)"
							>{formatDecimal(receipt.amount)}</span
						>
						{#if refunded !== null && refunded > 0n}
							<span class={hintText}>Refunded {formatCents(refunded)}</span>
						{/if}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</Card>
