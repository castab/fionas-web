<script lang="ts">
	import { Card } from '@fionas/ui';
	import type { CurrentStaffRequest } from '$lib/request-contract.js';
	import { formatMoney } from '$lib/presentation.js';
	import { paymentMethodLabel, receivedTimeLabel } from '$lib/payments.js';
	let { request }: { request: CurrentStaffRequest } = $props();
</script>

<Card class="flex flex-col gap-4" data-testid="payment-history">
	<h2 class="m-0 text-lg font-bold">Payment history</h2>
	{#if request.payments.length === 0}<p class="m-0 text-sm text-(--text-muted)">
			No payments recorded.
		</p>{/if}
	{#each request.payments as history (history.payment.paymentId)}
		{@const payment = history.payment}
		{@const allocations = history.allocations.filter(
			(allocation) => allocation.documentId === request.financial.id
		)}
		<article
			class="flex min-w-0 flex-col gap-2 border-t border-(--border-soft) pt-3"
			data-testid="payment-receipt"
		>
			<h3 class="m-0 text-base font-bold wrap-anywhere">
				{formatMoney(payment.amount, payment.currency)} received · {paymentMethodLabel(
					payment.method
				)}
			</h3>
			<time datetime={payment.receivedAt} class="text-xs text-(--text-muted)"
				>{receivedTimeLabel(payment.receivedAt)} (Pacific)</time
			>
			{#each allocations as allocation (allocation.allocationId)}
				<p class="m-0 text-xs text-(--text-muted)">
					{allocation.documentVersion === request.proposal?.documentVersion
						? 'Booking deposit'
						: 'Invoice payment'} · Originally allocated {formatMoney(
						allocation.amount,
						allocation.currency
					)} to {allocation.documentVersion === request.proposal?.documentVersion
						? 'Quote'
						: 'Invoice'} version {allocation.documentVersion}
				</p>
			{/each}
			{#if /[1-9]/.test(history.reconciliation.totalRefunded)}
				<p class="m-0 text-sm font-semibold">
					Refunded: {formatMoney(
						history.reconciliation.totalRefunded,
						history.reconciliation.currency
					)} · Net received: {formatMoney(
						history.reconciliation.netReceived,
						history.reconciliation.currency
					)}
				</p>
			{/if}
		</article>
	{/each}
</Card>
