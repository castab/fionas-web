<script lang="ts">
	import { Card } from '@fionas/ui';
	import type { CurrentStaffRequest } from '$lib/request-contract.js';
	import { formatMoney } from '$lib/presentation.js';
	import { paymentMethodLabel, receivedTimeLabel } from '$lib/payments.js';
	let { request }: { request: CurrentStaffRequest } = $props();
	const deposit = (version: number) => version === request.proposal?.documentVersion;
	type History = CurrentStaffRequest['payments'][number];
	/** " · applied to Quote v2" per original allocation to this document; the amount only when partial. */
	function appliedText(payment: History['payment'], allocations: History['allocations']): string {
		return allocations
			.map((allocation) => {
				const amount = formatMoney(allocation.amount, allocation.currency);
				const whole = amount === formatMoney(payment.amount, payment.currency);
				const document = deposit(allocation.documentVersion) ? 'Quote' : 'Invoice';
				return ` · ${whole ? '' : `${amount} `}applied to ${document} v${allocation.documentVersion}`;
			})
			.join('');
	}
</script>

{#if request.payments.length}
	<Card class="flex flex-col gap-3 p-[18px] sm:p-5" data-testid="payment-history">
		<h2
			class="m-0 font-sans text-[11px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-heading) uppercase"
		>
			Payment history
		</h2>
		<ul class="m-0 flex list-none flex-col p-0">
			{#each request.payments as history (history.payment.paymentId)}
				{@const payment = history.payment}
				{@const allocations = history.allocations.filter(
					(allocation) => allocation.documentId === request.financial.id
				)}
				<li
					class="flex items-center gap-3 border-b border-(--border-soft) py-2.5 last:border-b-0"
					data-testid="payment-receipt"
				>
					<span class="flex min-w-0 flex-1 flex-col gap-0.5">
						<span class="text-[13.5px] font-semibold wrap-anywhere">
							{allocations.some((allocation) => deposit(allocation.documentVersion))
								? 'Deposit'
								: 'Payment'} · {paymentMethodLabel(payment.method)}
						</span>
						<span class="text-[11.5px] wrap-anywhere text-(--text-muted)">
							Received <time datetime={payment.receivedAt}
								>{receivedTimeLabel(payment.receivedAt)}</time
							>
							(Pacific){appliedText(payment, allocations)}
						</span>
						{#if /[1-9]/.test(history.reconciliation.totalRefunded)}
							<span class="text-xs font-semibold wrap-anywhere">
								Refunded {formatMoney(
									history.reconciliation.totalRefunded,
									history.reconciliation.currency
								)} · Net received {formatMoney(
									history.reconciliation.netReceived,
									history.reconciliation.currency
								)}
							</span>
						{/if}
					</span>
					<span class="text-[13.5px] font-bold whitespace-nowrap text-moss-600"
						>{formatMoney(payment.amount, payment.currency)}</span
					>
				</li>
			{/each}
		</ul>
	</Card>
{/if}
