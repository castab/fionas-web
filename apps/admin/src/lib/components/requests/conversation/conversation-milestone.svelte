<script lang="ts">
	import type { TimelineItem } from '$lib/conversation-contract.js';
	import { actorLabel } from '$lib/conversation.js';
	import { receivedTimeLabel, paymentMethodLabel } from '$lib/payments.js';
	import { formatMoney } from '$lib/presentation.js';
	import { focusRing } from '@fionas/ui';
	let { item, userId }: { item: Exclude<TimelineItem, { kind: 'MESSAGE' }>; userId: string } =
		$props();
	const label = $derived.by(() => {
		switch (item.kind) {
			case 'QUOTE_PUBLISHED':
				return `Quote v${item.financial.version} published`;
			case 'INVOICE_AMENDED':
				return `Invoice v${item.financial.version} amended`;
			case 'PAYMENT_RECORDED':
				return item.classification === 'DEPOSIT'
					? 'Deposit received'
					: 'Additional payment received';
			case 'REFUND_RECORDED':
				return 'Refund recorded';
			case 'COMMUNICATION_ACKNOWLEDGED':
				return 'Communication marked as read';
			case 'SERVED':
				return 'Event served';
			case 'CLOSED':
				return 'Event closed';
			case 'DECLINED':
				return 'Request declined';
			default: {
				const exhaustive: never = item;
				return exhaustive;
			}
		}
	});
</script>

<details class="min-w-0 rounded-input bg-cream-100 p-4">
	<summary class={`cursor-pointer rounded-sm ${focusRing}`}>
		<span class="ml-1 text-sm font-semibold">{label}</span>
		{#if 'financial' in item}<span class="ml-2 inline-block font-semibold"
				>{formatMoney(item.financial.total, item.financial.currency)}</span
			>{:else if 'amount' in item}<span class="ml-2 inline-block font-semibold"
				>{formatMoney(item.amount, item.currency)}</span
			>{/if}
		<time class="mt-1 block text-xs text-(--text-muted)" datetime={item.occurredAt}
			>{receivedTimeLabel(item.occurredAt)} Pacific{#if 'actor' in item}{` · ${actorLabel(item.actor, userId)}`}{/if}</time
		>
		{#if item.kind === 'QUOTE_PUBLISHED' && item.depositRequirement.state === 'ACTIVE'}<span
				class="mt-1 block text-xs"
				>Deposit {formatMoney(
					item.depositRequirement.requiredAmount.amount,
					item.depositRequirement.requiredAmount.currency
				)}</span
			>{/if}
	</summary>
	<div class="mt-3 space-y-3 border-t border-olive-200 pt-3 text-sm wrap-anywhere">
		{#if 'financial' in item}
			{#if item.kind === 'QUOTE_PUBLISHED'}<p>
					{item.proposal.issuanceKind === 'INITIAL'
						? 'Initial quote'
						: item.proposal.issuanceKind === 'QUOTE_REVISED'
							? 'Revised quote'
							: 'Deposit terms updated'}. Historical publication; this does not indicate an email
					was sent.
				</p>{/if}
			<dl class="space-y-2">
				{#each item.financial.lines as line (line.id)}<div
						class="flex items-start justify-between gap-4"
					>
						<dt class="min-w-0">
							{line.description}{#if line.subDescription}<span
									class="block text-xs text-(--text-muted)">{line.subDescription}</span
								>{/if}
						</dt>
						<dd class="shrink-0">{formatMoney(line.total, item.financial.currency)}</dd>
					</div>{/each}
				<div class="flex justify-between gap-4 border-t border-olive-200 pt-2">
					<dt>Subtotal</dt>
					<dd>{formatMoney(item.financial.subtotal, item.financial.currency)}</dd>
				</div>
				<div class="flex justify-between gap-4">
					<dt>Tax</dt>
					<dd>{formatMoney(item.financial.taxAmount, item.financial.currency)}</dd>
				</div>
				<div class="flex justify-between gap-4 font-semibold">
					<dt>Historical total</dt>
					<dd>{formatMoney(item.financial.total, item.financial.currency)}</dd>
				</div>
			</dl>
		{:else if item.kind === 'PAYMENT_RECORDED'}
			<p>{paymentMethodLabel(item.method)} · Payment {item.paymentId}</p>
			{#if item.proposalId}<p>
					Proposal {item.proposalId} · Deposit revision {item.depositRequirementRevision}
				</p>{/if}
			{#if item.externalReference}<p>
					{item.externalReference.provider}: {item.externalReference.reference}
				</p>{/if}
			<ul class="space-y-2">
				{#each item.allocations as allocation (allocation.allocationId)}<li>
						{formatMoney(allocation.amount, allocation.currency)} applied to {allocation.canonical
							? (allocation.documentStage ?? 'document')
							: 'related document'} v{allocation.documentVersion}<span
							class="block text-xs text-(--text-muted)"
							>{allocation.documentId} · {receivedTimeLabel(allocation.allocatedAt)} Pacific</span
						>
					</li>{/each}
			</ul>
		{:else if item.kind === 'REFUND_RECORDED'}
			<p>
				{paymentMethodLabel(item.method)} · {item.paymentClassification === 'DEPOSIT'
					? 'Deposit'
					: 'Additional payment'} refund
			</p>
			<p>Payment {item.paymentId}</p>
			{#if item.externalReference}<p>
					{item.externalReference.provider}: {item.externalReference.reference}
				</p>{/if}
			<ul class="space-y-2">
				{#each item.unwound as allocation (allocation.refundAllocationId)}<li>
						{formatMoney(allocation.amount, allocation.currency)} unwound from document v{allocation.documentVersion}<span
							class="block text-xs text-(--text-muted)"
							>{allocation.documentId} · Allocation {allocation.paymentAllocationId}</span
						>
					</li>{/each}
			</ul>
			{#if !item.unwound.length}<p>No allocation unwind recorded.</p>{/if}
		{:else if item.kind === 'DECLINED'}<p><strong>Internal reason:</strong> {item.reason}</p>
		{:else if item.kind === 'COMMUNICATION_ACKNOWLEDGED'}<p>
				Staff acknowledged customer communication. Email delivery and provider conversation state
				are unchanged.
			</p>
		{:else}<p>{label} by {actorLabel(item.actor, userId)}.</p>{/if}
	</div>
</details>
