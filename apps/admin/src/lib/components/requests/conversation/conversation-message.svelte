<script lang="ts">
	import { untrack } from 'svelte';
	import { cn, focusRing } from '@fionas/ui';
	import type { ConversationMessage } from '$lib/conversation-contract.js';
	import { messageStatus, splitQuotedTrail } from '$lib/conversation.js';
	import { receivedTimeLabel } from '$lib/payments.js';
	let { message, newest }: { message: ConversationMessage; newest: boolean } = $props();
	// Initialize once. Keyed message identity preserves the staff member's disclosure on refresh.
	let open = $state(untrack(() => newest));
	const unavailable = 'Plain-text content is unavailable for this email.';
	const inbound = $derived(message.direction === 'inbound');
	const name = $derived(message.senderName || message.senderAddress);
	// Earlier mail a client quoted below the reply is folded, never removed.
	const split = $derived(message.text == null ? null : splitQuotedTrail(message.text));
	const snippet = $derived(split?.body.replace(/\s+/g, ' ').trim().slice(0, 180) || unavailable);
	const failed = [
		'Bounced',
		'Failed to send',
		'Delivery failed',
		'Reported as spam',
		'Delivery suppressed',
		'Send status uncertain'
	];
	const tone = (status: string) =>
		failed.includes(status)
			? 'bg-rust-600/12 text-rust-600'
			: status === 'Delivered'
				? 'bg-moss-600/18 text-olive-900'
				: 'bg-olive-700/12 text-olive-800';
</script>

<details bind:open id={`message-${message.messageId}`} class="group min-w-0">
	<summary
		class={cn(
			'flex cursor-pointer list-none items-start gap-3 px-[18px] py-3.5 [&::-webkit-details-marker]:hidden',
			'transition-colors duration-(--dur-fast) ease-(--ease-out) hover:bg-cream-200/45',
			focusRing,
			'focus-visible:-outline-offset-3'
		)}
	>
		<span
			aria-hidden="true"
			class={cn(
				'flex size-[34px] flex-none items-center justify-center rounded-full text-sm leading-none font-bold',
				inbound ? 'bg-paper-200 text-(--text-body)' : 'bg-olive-700 text-cream-200'
			)}>{name.trim().charAt(0).toUpperCase()}</span
		>
		<span class="flex min-w-0 flex-1 flex-col gap-0.5">
			<span class="flex min-w-0 items-baseline gap-2">
				<span class="sr-only">{inbound ? 'Customer email' : 'Staff reply'}</span>
				<span class="min-w-0 truncate text-[13.5px] font-semibold">{name}</span>
				<time
					datetime={message.occurredAt}
					class="ml-auto shrink-0 text-[11px] whitespace-nowrap text-(--text-muted)"
					>{receivedTimeLabel(message.occurredAt)} Pacific</time
				>
			</span>
			<span class="truncate text-[12.5px] text-(--text-muted) group-open:hidden">{snippet}</span>
			<span class="hidden text-[12.5px] wrap-anywhere text-(--text-muted) group-open:block"
				>{message.senderAddress} · To {message.recipient}</span
			>
		</span>
	</summary>
	<div class="flex flex-col gap-3 pr-[18px] pb-[18px] pl-16">
		{#if !inbound}<div class="flex flex-wrap gap-1.5">
				{#each messageStatus(message) as status (status)}<span
						class={cn(
							'inline-flex items-center rounded-full px-2.5 py-1 font-sans text-[10px] leading-[1.4] font-semibold tracking-(--track-caps-tight) uppercase',
							tone(status)
						)}>{status}</span
					>{/each}
			</div>{/if}
		<p class="m-0 text-[13.5px] leading-[1.65] wrap-anywhere whitespace-pre-wrap">
			{split?.body ?? unavailable}
		</p>
		{#if split?.quoted}<details class="group/quote min-w-0">
				<summary
					class={cn(
						'inline-flex cursor-pointer list-none items-center rounded-full bg-olive-700/10 px-2.5 py-1 [&::-webkit-details-marker]:hidden',
						'font-sans text-[10px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-olive-800 uppercase',
						'transition-colors duration-(--dur-fast) ease-(--ease-out) hover:bg-olive-700/18',
						focusRing
					)}
					><span class="group-open/quote:hidden">Show quoted text</span><span
						class="hidden group-open/quote:inline">Hide quoted text</span
					></summary
				>
				<p
					class="m-0 mt-2.5 border-l-2 border-(--border-soft) pl-3 text-[12.5px] leading-[1.6] wrap-anywhere whitespace-pre-wrap text-(--text-muted)"
				>
					{split.quoted}
				</p>
			</details>{/if}
	</div>
</details>
