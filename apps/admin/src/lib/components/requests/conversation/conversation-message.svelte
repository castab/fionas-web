<script lang="ts">
	import { untrack } from 'svelte';
	import { Badge, focusRing } from '@fionas/ui';
	import type { ConversationMessage } from '$lib/conversation-contract.js';
	import { messageStatus } from '$lib/conversation.js';
	import { receivedTimeLabel } from '$lib/payments.js';
	let { message, newest }: { message: ConversationMessage; newest: boolean } = $props();
	// Initialize once. Keyed message identity preserves the staff member's disclosure on refresh.
	let open = $state(untrack(() => newest));
</script>

<details
	bind:open
	id={`message-${message.messageId}`}
	class="min-w-0 rounded-input border border-olive-200 bg-(--surface-card) p-4"
>
	<summary class={`cursor-pointer rounded-sm ${focusRing}`}>
		<span class="ml-1 font-semibold"
			>{message.direction === 'inbound' ? 'Customer email' : 'Staff reply'}</span
		>
		<span class="mt-2 block text-sm wrap-anywhere"
			>{message.senderName ? `${message.senderName} · ` : ''}{message.senderAddress}</span
		>
		<time datetime={message.occurredAt} class="mt-1 block text-xs text-(--text-muted)"
			>{receivedTimeLabel(message.occurredAt)} Pacific</time
		>
		<span class="mt-3 line-clamp-2 text-sm wrap-anywhere whitespace-pre-wrap text-(--text-muted)"
			>{message.text?.slice(0, 180) ?? 'Plain-text content is unavailable for this email.'}</span
		>
	</summary>
	<div class="mt-4 border-t border-olive-100 pt-4">
		<p class="text-xs wrap-anywhere text-(--text-muted)">To: {message.recipient}</p>
		<p class="mt-3 text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap">
			{message.text ?? 'Plain-text content is unavailable for this email.'}
		</p>
	</div>
	<div class="mt-3 flex flex-wrap gap-2">
		{#each messageStatus(message) as status (status)}<Badge
				size="sm"
				tone={[
					'Bounced',
					'Failed to send',
					'Delivery failed',
					'Reported as spam',
					'Delivery suppressed',
					'Send status uncertain'
				].includes(status)
					? 'rust'
					: 'outline'}>{status}</Badge
			>{/each}
	</div>
</details>
