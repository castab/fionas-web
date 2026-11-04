<script lang="ts">
	import { Card, capsSm, capsXs, cn, hintText } from '@fionas/ui';
	import type { CustomerPaymentSummary } from '$lib/payments/contract.js';
	import { decimalToCents, formatCents, formatDecimal } from '$lib/payments/money.js';
	import { documentLabel, eventDateLabel, paidPercent } from '$lib/payments/view.js';

	let { summary }: { summary: CustomerPaymentSummary } = $props();

	const label = $derived(documentLabel(summary));
	const quoted = $derived(summary.lifecycle === 'QUOTED');
	const balanceCents = $derived(decimalToCents(summary.balance));
	const percent = $derived(quoted ? null : paidPercent(summary));
	const depositDue = $derived(
		quoted && summary.mode === 'DEPOSIT' ? formatDecimal(summary.requiredAmount) : null
	);
	const micro = cn(capsXs, 'text-(--text-muted)');
	const figure =
		'font-sans text-[19px] leading-[1.25] font-bold wrap-anywhere text-(--text-heading)';
</script>

<Card class="flex flex-col gap-5 px-[26px] py-6 max-[600px]:px-5" data-testid="payment-overview">
	<dl class="m-0 grid grid-cols-1 gap-4 min-[480px]:grid-cols-2">
		<div class="flex flex-col gap-0.5">
			<dt class={micro}>Event date</dt>
			<dd
				class="m-0 font-sans text-[15px] font-semibold text-(--text-body)"
				data-testid="event-date"
			>
				{eventDateLabel(summary.eventDate)}
			</dd>
		</div>
		{#if label}
			<div class="flex flex-col gap-0.5">
				<dt class={micro}>{summary.document.stage === 'INVOICE' ? 'Invoice' : 'Quote'}</dt>
				<dd
					class="m-0 font-sans text-[15px] font-semibold text-(--text-body)"
					data-testid="document-label"
				>
					{label}
					{#if summary.document.stage === 'INVOICE' && summary.document.acceptedQuoteRevision}
						<span class={cn(hintText, 'block font-normal')}
							>Booked from Quote v{summary.document.acceptedQuoteRevision}</span
						>
					{/if}
				</dd>
			</div>
		{/if}
	</dl>

	<div class="flex flex-col gap-3 border-t border-(--border-soft) pt-4">
		<h2 class={cn(capsSm, 'm-0 text-(--text-heading)')}>Summary</h2>
		<dl class="m-0 grid grid-cols-1 gap-x-4 gap-y-3 min-[420px]:grid-cols-3">
			<div class="flex flex-col gap-0.5" data-testid="figure-total">
				<dt class={micro}>{quoted ? 'Quote total' : 'Invoice total'}</dt>
				<dd class={cn('m-0', figure)}>{formatDecimal(summary.document.totalAmount)}</dd>
			</div>
			<div class="flex flex-col gap-0.5" data-testid="figure-paid">
				<dt class={micro}>Payments applied</dt>
				<dd class={cn('m-0', figure, 'text-moss-600')}>{formatDecimal(summary.paidAmount)}</dd>
			</div>
			<div class="flex flex-col gap-0.5" data-testid="figure-balance">
				<dt class={micro}>
					{balanceCents !== null && balanceCents < 0n ? 'Credit' : 'Remaining balance'}
				</dt>
				<dd class={cn('m-0', figure)}>
					{balanceCents !== null && balanceCents < 0n
						? formatCents(-balanceCents)
						: formatDecimal(summary.balance)}
				</dd>
			</div>
		</dl>
		{#if depositDue}
			<p
				class="m-0 rounded-input bg-cream-200 px-4 py-3 text-(--text-body) [font:var(--type-body-sm)]"
				data-testid="deposit-note"
			>
				A deposit of <strong class="font-semibold">{depositDue}</strong> holds your date. The rest is
				due on your Invoice after you book.
			</p>
		{/if}
		{#if percent !== null}
			<div class="flex flex-col gap-1.5">
				<div
					role="progressbar"
					aria-label="Payment progress"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={percent}
					aria-valuetext="{formatDecimal(summary.paidAmount)} of {formatDecimal(
						summary.document.totalAmount
					)} paid"
					class="h-2 overflow-hidden rounded-full bg-(--border-soft)"
				>
					<div
						class="h-full rounded-full bg-moss-600 transition-[width] duration-(--dur-med) ease-out"
						style:width="{percent}%"
					></div>
				</div>
				<p class={cn(hintText, 'm-0')}>
					{formatDecimal(summary.paidAmount)} of {formatDecimal(summary.document.totalAmount)} paid
				</p>
			</div>
		{/if}
	</div>
</Card>
