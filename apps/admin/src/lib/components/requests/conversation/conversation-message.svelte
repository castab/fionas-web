<script lang="ts">
	import { untrack } from 'svelte';
	import { site } from '@fionas/shared';
	import { cn, focusRing } from '@fionas/ui';
	import type { ConversationMessage } from '$lib/conversation-contract.js';
	import { messageStatus, splitQuotedTrail } from '$lib/conversation.js';
	import { emailedVersionLabel, kindLabel } from '$lib/financial-email.js';
	import { receivedTimeLabel } from '$lib/payments.js';
	let {
		message,
		newest,
		userId = ''
	}: { message: ConversationMessage; newest: boolean; userId?: string } = $props();
	// The provider message a financial-email command produced: labelled here, never a second band.
	const financialEmail = $derived(message.financialEmail ?? null);
	// Initialize once. Keyed message identity preserves the staff member's disclosure on refresh.
	let open = $state(untrack(() => newest));
	const unavailable = 'Plain-text content is unavailable for this email.';
	const inbound = $derived(message.direction === 'inbound');
	const name = $derived(message.senderName || message.senderAddress);
	// An inbound recipient is the per-conversation reply-routing address: internal, so it is kept
	// out of the header and shown only under Message details.
	const addressLine = $derived(
		inbound
			? `${message.senderName ? `${message.senderAddress} · ` : ''}To ${site.name}`
			: `To ${message.recipient}`
	);
	// READABLE text is complete provider text, payment links and quoted history included. Earlier
	// mail a client quoted below the reply is folded for presentation only, never removed.
	const readable = $derived(
		message.textVisibility !== 'PROVIDER_CONTENT_UNAVAILABLE' && typeof message.text === 'string'
	);
	const split = $derived(readable ? splitQuotedTrail(message.text!) : null);
	const empty = 'This email has no plain-text content.';
	const snippet = $derived(
		split ? split.body.replace(/\s+/g, ' ').trim().slice(0, 180) || empty : unavailable
	);
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
			'relative flex cursor-pointer list-none items-start gap-3 px-[18px] py-3.5 [&::-webkit-details-marker]:hidden',
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
				<span class="sr-only"
					>{inbound
						? 'Customer email'
						: financialEmail
							? `${kindLabel(financialEmail.kind)} email`
							: 'Staff reply'}</span
				>
				<span class="min-w-0 truncate text-[13.5px] font-semibold">{name}</span>
				{#if financialEmail}<span
						class="shrink-0 rounded-full bg-olive-700 px-2 py-0.5 font-sans text-[9.5px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-cream-200 uppercase"
						data-testid="financial-email-chip">{kindLabel(financialEmail.kind)} emailed</span
					>{/if}
				<time
					datetime={message.occurredAt}
					class="ml-auto shrink-0 text-[11px] whitespace-nowrap text-(--text-muted)"
					>{receivedTimeLabel(message.occurredAt)} Pacific</time
				>
			</span>
			<span class="truncate text-[12.5px] text-(--text-muted) group-open:hidden">{snippet}</span>
			<span class="hidden text-[12.5px] wrap-anywhere text-(--text-muted) group-open:block"
				>{addressLine}</span
			>
		</span>
	</summary>
	<div class="flex flex-col gap-3 pr-[18px] pb-[18px] pl-16">
		{#if financialEmail}<p
				class="m-0 text-[12px] leading-[1.5] text-(--text-muted)"
				data-testid="financial-email-meta"
			>
				<span class="font-semibold text-(--text-body)">{emailedVersionLabel(financialEmail)}</span>
				(staff only) · {financialEmail.current
					? `Current ${kindLabel(financialEmail.kind)}`
					: `Earlier ${kindLabel(financialEmail.kind)}`} · Sent by {financialEmail.actor
					.principalId === userId
					? 'you'
					: 'staff'}
			</p>{/if}
		{#if !inbound}<div class="flex flex-wrap gap-1.5">
				{#each messageStatus(message) as status (status)}<span
						class={cn(
							'inline-flex items-center rounded-full px-2.5 py-1 font-sans text-[10px] leading-[1.4] font-semibold tracking-(--track-caps-tight) uppercase',
							tone(status)
						)}>{status}</span
					>{/each}
			</div>{/if}
		<p
			class={cn(
				'm-0 text-[13.5px] leading-[1.65] wrap-anywhere whitespace-pre-wrap',
				(!split || !split.body.trim()) && 'text-(--text-muted)'
			)}
		>
			{split ? split.body || empty : unavailable}
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
		<details class="group/details min-w-0">
			<summary
				class={cn(
					'inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-[11px] text-(--text-muted) [&::-webkit-details-marker]:hidden',
					'underline-offset-2 hover:underline',
					focusRing
				)}
			>
				Message details<svg
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.75"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
					class="-rotate-90 transition-transform duration-(--dur-fast) ease-(--ease-out) group-open/details:rotate-0"
					><path d="m6 9 6 6 6-6"></path></svg
				>
			</summary>
			<dl
				class="m-0 mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11.5px] leading-[1.5] text-(--text-muted)"
			>
				<dt>From</dt>
				<dd class="m-0 wrap-anywhere select-all">{message.senderAddress}</dd>
				<dt>To</dt>
				<dd class="m-0 wrap-anywhere select-all">{message.recipient}</dd>
				<dt>Message ID</dt>
				<dd class="m-0 wrap-anywhere select-all">{message.messageId}</dd>
				{#if financialEmail}<dt>Send ID</dt>
					<dd class="m-0 wrap-anywhere select-all">{financialEmail.sendId}</dd>{/if}
			</dl>
		</details>
	</div>
</details>
