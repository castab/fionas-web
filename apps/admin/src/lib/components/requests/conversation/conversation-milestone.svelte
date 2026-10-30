<script lang="ts">
	import type { TimelineItem } from '$lib/conversation-contract.js';
	import { actorLabel } from '$lib/conversation.js';
	import { receivedTimeLabel, paymentMethodLabel } from '$lib/payments.js';
	import { formatMoney } from '$lib/presentation.js';
	import { cn, focusRing } from '@fionas/ui';
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
	const amount = $derived(
		'financial' in item
			? formatMoney(item.financial.total, item.financial.currency)
			: 'amount' in item
				? formatMoney(item.amount, item.currency)
				: null
	);
	const dot = $derived(
		item.kind === 'PAYMENT_RECORDED' || item.kind === 'SERVED'
			? 'bg-moss-600'
			: item.kind === 'REFUND_RECORDED' || item.kind === 'DECLINED'
				? 'bg-rust-600'
				: item.kind === 'CLOSED'
					? 'bg-olive-900'
					: 'bg-olive-700'
	);
	// Financial snapshots and money movements carry detail worth opening; the rest are plain bands.
	const expandable = $derived(
		'financial' in item || item.kind === 'PAYMENT_RECORDED' || item.kind === 'REFUND_RECORDED'
	);
	const bandText =
		'min-w-0 flex-1 font-sans text-[10.5px] leading-[1.45] font-semibold tracking-[.06em] text-(--text-muted) uppercase';
	const micro =
		'm-0 font-sans text-[9.5px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-muted) uppercase';
</script>

{#snippet heading()}
	<span aria-hidden="true" class={cn('size-1.5 flex-none rounded-full', dot)}></span>
	<span class={bandText}
		><span>{label}</span>{#if amount}{` — ${amount}`}{/if} ·
		<time datetime={item.occurredAt}>{receivedTimeLabel(item.occurredAt)} Pacific</time
		>{#if 'actor' in item}{` · ${actorLabel(item.actor, userId)}`}{/if}</span
	>
{/snippet}

{#if expandable}
	<details class="group min-w-0 bg-cream-300/50">
		<summary
			class={cn(
				'flex cursor-pointer list-none items-center gap-2.5 px-[18px] py-3 [&::-webkit-details-marker]:hidden',
				'transition-colors duration-(--dur-fast) ease-(--ease-out) hover:bg-cream-300/75',
				focusRing,
				'focus-visible:-outline-offset-3'
			)}
		>
			{@render heading()}
			<svg
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="1.75"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
				class="flex-none -rotate-90 text-(--text-muted) transition-transform duration-(--dur-fast) ease-(--ease-out) group-open:rotate-0"
				><path d="m6 9 6 6 6-6"></path></svg
			>
		</summary>
		<div class="flex flex-col gap-3 pt-1 pr-[18px] pb-4 pl-[34px] text-[13px] wrap-anywhere">
			{#if 'financial' in item}
				<dl class="m-0 flex flex-col">
					{#each item.financial.lines as line (line.id)}<div
							class="flex items-start justify-between gap-3 border-b border-(--border-soft) py-1.5"
						>
							<dt class="min-w-0">
								{line.description}{#if line.subDescription}<span
										class="block text-xs text-(--text-muted)">{line.subDescription}</span
									>{/if}
							</dt>
							<dd class="m-0 shrink-0 font-semibold whitespace-nowrap">
								{formatMoney(line.total, item.financial.currency)}
							</dd>
						</div>{/each}
					<div class="flex justify-between gap-3 py-1.5 text-(--text-muted)">
						<dt>Subtotal</dt>
						<dd class="m-0 whitespace-nowrap">
							{formatMoney(item.financial.subtotal, item.financial.currency)}
						</dd>
					</div>
					<div
						class="flex justify-between gap-3 border-b border-(--border-soft) pb-1.5 text-(--text-muted)"
					>
						<dt>Tax</dt>
						<dd class="m-0 whitespace-nowrap">
							{formatMoney(item.financial.taxAmount, item.financial.currency)}
						</dd>
					</div>
				</dl>
				<div class="flex flex-wrap gap-4">
					<div class="flex flex-col gap-0.5">
						<span class={micro}>Historical total</span>
						<span class="text-[17px] font-bold text-(--text-heading)"
							>{formatMoney(item.financial.total, item.financial.currency)}</span
						>
					</div>
					{#if item.kind === 'QUOTE_PUBLISHED' && item.depositRequirement.state === 'ACTIVE'}<div
							class="flex flex-col gap-0.5"
						>
							<span class={micro}>Deposit to hold the date</span>
							<span class="text-[17px] font-bold text-(--text-heading)"
								>{formatMoney(
									item.depositRequirement.requiredAmount.amount,
									item.depositRequirement.requiredAmount.currency
								)}</span
							>
						</div>{/if}
				</div>
				{#if item.kind === 'QUOTE_PUBLISHED'}<p class="m-0 text-xs text-(--text-muted)">
						{item.proposal.issuanceKind === 'INITIAL'
							? 'Initial quote'
							: item.proposal.issuanceKind === 'QUOTE_REVISED'
								? 'Revised quote'
								: 'Deposit terms updated'}. Historical publication; this does not indicate an email
						was sent.
					</p>{/if}
			{:else if item.kind === 'PAYMENT_RECORDED'}
				<p class="m-0">{paymentMethodLabel(item.method)} · Payment {item.paymentId}</p>
				{#if item.proposalId}<p class="m-0">
						Proposal {item.proposalId} · Deposit revision {item.depositRequirementRevision}
					</p>{/if}
				{#if item.externalReference}<p class="m-0">
						{item.externalReference.provider}: {item.externalReference.reference}
					</p>{/if}
				<ul class="m-0 flex list-none flex-col p-0">
					{#each item.allocations as allocation (allocation.allocationId)}<li
							class="border-b border-(--border-soft) py-1.5"
						>
							{formatMoney(allocation.amount, allocation.currency)} applied to {allocation.canonical
								? (allocation.documentStage ?? 'document')
								: 'related document'} v{allocation.documentVersion}<span
								class="block text-xs text-(--text-muted)"
								>{allocation.documentId} · {receivedTimeLabel(allocation.allocatedAt)} Pacific</span
							>
						</li>{/each}
				</ul>
			{:else if item.kind === 'REFUND_RECORDED'}
				<p class="m-0">
					{paymentMethodLabel(item.method)} · {item.paymentClassification === 'DEPOSIT'
						? 'Deposit'
						: 'Additional payment'} refund
				</p>
				<p class="m-0">Payment {item.paymentId}</p>
				{#if item.externalReference}<p class="m-0">
						{item.externalReference.provider}: {item.externalReference.reference}
					</p>{/if}
				<ul class="m-0 flex list-none flex-col p-0">
					{#each item.unwound as allocation (allocation.refundAllocationId)}<li
							class="border-b border-(--border-soft) py-1.5"
						>
							{formatMoney(allocation.amount, allocation.currency)} unwound from document v{allocation.documentVersion}<span
								class="block text-xs text-(--text-muted)"
								>{allocation.documentId} · Allocation {allocation.paymentAllocationId}</span
							>
						</li>{/each}
				</ul>
				{#if !item.unwound.length}<p class="m-0">No allocation unwind recorded.</p>{/if}
			{/if}
		</div>
	</details>
{:else}
	<div class="flex min-w-0 flex-col gap-1.5 bg-cream-300/50 px-[18px] py-3">
		<div class="flex items-center gap-2.5">{@render heading()}</div>
		{#if item.kind === 'DECLINED'}<p
				class="m-0 pl-4 text-xs leading-[1.6] wrap-anywhere text-(--text-muted) italic"
			>
				<strong class="font-semibold not-italic">Internal reason:</strong>
				{item.reason}
			</p>
		{:else if item.kind === 'COMMUNICATION_ACKNOWLEDGED'}<p
				class="m-0 pl-4 text-xs leading-[1.6] text-(--text-muted) italic"
			>
				Email delivery and provider conversation state are unchanged.
			</p>{/if}
	</div>
{/if}
