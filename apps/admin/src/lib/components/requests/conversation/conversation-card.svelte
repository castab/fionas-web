<script lang="ts">
	import { untrack, tick } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { enhance, applyAction } from '$app/forms';
	import type { ActionResult } from '@sveltejs/kit';
	import { Badge, Button, Card } from '@fionas/ui';
	import type {
		CommunicationSummary,
		ConversationActionResult,
		ReplyDraft,
		StaffTimeline
	} from '$lib/conversation-contract.js';
	import type { InquiryResponse } from '$lib/request-contract.js';
	import { availabilityCopy, isStaffTimeline, replyExpectation } from '$lib/conversation.js';
	import { receivedTimeLabel } from '$lib/payments.js';
	import { workspaceAction, type RequestListQuery } from '$lib/request-list.js';
	import ConversationMessage from './conversation-message.svelte';
	import ConversationMilestone from './conversation-milestone.svelte';
	import ConversationReply from './conversation-reply.svelte';
	let {
		inquiry,
		timeline: initialTimeline,
		summary,
		reply,
		recoveryLost = false,
		forbidden = false,
		blocked = false,
		userId,
		permissions,
		route,
		endpoint,
		returnContext,
		result
	}: {
		inquiry: InquiryResponse;
		timeline: StaffTimeline | null;
		summary?: CommunicationSummary;
		reply: ReplyDraft | null;
		recoveryLost?: boolean;
		forbidden?: boolean;
		blocked?: boolean;
		userId: string;
		permissions: string[];
		route: string;
		endpoint: string;
		returnContext: RequestListQuery | null;
		result: ConversationActionResult | null;
	} = $props();
	let timeline = $state(untrack(() => initialTimeline));
	let refreshing = $state(false);
	let acknowledging = $state(false);
	let status = $state(untrack(() => result?.conversationError ?? reply?.message ?? ''));
	let statusElement: HTMLDivElement;
	let newMessage = $state<string | null>(null);
	let haveMessageBaseline = $state(
		untrack(
			() =>
				initialTimeline?.conversation.state === 'READY' ||
				initialTimeline?.conversation.state === 'EMPTY'
		)
	);
	const seen = new SvelteSet(
		untrack(() => initialTimeline?.items.filter((i) => i.kind === 'MESSAGE').map((i) => i.id) ?? [])
	);
	const attention = $derived(timeline?.attention ?? summary);
	const availability = $derived(
		timeline?.conversation.state ?? (forbidden ? 'FORBIDDEN' : 'UNAVAILABLE')
	);
	const expectation = $derived(replyExpectation(timeline));
	const canReply = $derived(
		permissions.includes('fionas.communications.read') &&
			permissions.includes('fionas.communications.send')
	);
	// Attention stays visible, but it can only be cleared once the messages themselves are shown.
	const reviewable = $derived(
		availability === 'READY' && permissions.includes('fionas.communications.read')
	);
	// When the composer form exists, Mark as read submits through it so its unsent text reaches
	// the server natively and survives the PRG. Initialized from props for the no-JS render.
	let composerActive = $state(
		untrack(() => {
			const draft = result?.reply ?? reply;
			return (
				canReply && !(result?.recoveryLost ?? recoveryLost) && !!draft && draft.state !== 'accepted'
			);
		})
	);
	const acknowledgeAction = $derived(workspaceAction(returnContext, 'acknowledgeConversation'));
	function acknowledgeSubmit({ cancel }: { cancel: () => void }) {
		if (acknowledging || blocked) {
			cancel();
			return;
		}
		acknowledging = true;
		return async ({ result }: { result: ActionResult }) => {
			acknowledging = false;
			if (result.type === 'redirect') await applyAction(result);
			else
				await announce(
					result.type === 'failure'
						? String(result.data?.conversationError ?? 'Acknowledgement was not confirmed.')
						: 'Acknowledgement was not confirmed. Refresh and review.'
				);
		};
	}
	async function announce(message: string) {
		status = message;
		await tick();
		statusElement?.focus();
	}
	async function refresh(event: SubmitEvent) {
		event.preventDefault();
		if (refreshing) return;
		refreshing = true;
		try {
			const response = await fetch(endpoint, { cache: 'no-store' });
			const next: unknown = await response.json();
			if (!response.ok || !isStaffTimeline(next, inquiry.id)) {
				await announce(
					'Conversation refresh was unavailable. The previously loaded view is still shown.'
				);
				return;
			}
			let detected = false;
			for (const item of next.items) {
				if (item.kind === 'MESSAGE' && item.direction === 'inbound' && !seen.has(item.id))
					if (haveMessageBaseline) {
						newMessage = item.messageId;
						detected = true;
					}
				seen.add(item.id);
			}
			if (next.conversation.state === 'READY') haveMessageBaseline = true;
			timeline = next;
			await announce(
				detected ? `New customer email for ${inquiry.name}.` : 'Conversation refreshed.'
			);
		} catch {
			await announce('Conversation refresh was unavailable. Try again when connected.');
		} finally {
			refreshing = false;
		}
	}
</script>

<Card id="conversation" class="min-w-0" data-testid="conversation">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="min-w-0">
			<h2 class="text-(--text-heading) [font:var(--type-h3)]">Conversation</h2>
			<p class="mt-2 text-sm font-semibold wrap-anywhere">
				{timeline?.conversation.subject ?? 'Booking correspondence'}
			</p>
			<p class="mt-1 text-xs wrap-anywhere text-(--text-muted)">{inquiry.name} · {inquiry.email}</p>
		</div>
		<form method="GET" action={route + '#conversation'} onsubmit={refresh}>
			{#if returnContext}<input
					type="hidden"
					name="from"
					value={new URLSearchParams(route.split('?')[1]).get('from') ?? ''}
				/>{/if}
			<Button type="submit" variant="secondary" size="sm" disabled={refreshing}
				>{refreshing ? 'Refreshing…' : 'Refresh conversation'}</Button
			>
		</form>
	</div>
	<div
		bind:this={statusElement}
		tabindex="-1"
		role="status"
		class="mt-3 text-sm text-(--text-body)"
	>
		{status}
	</div>
	{#if attention?.needsReply}
		<div class="mt-4 rounded-input border border-olive-300 bg-cream-100 p-4">
			<Badge tone="rust" size="sm">Needs reply</Badge>
			<p class="mt-2 text-sm font-semibold">Customer message needs attention.</p>
			{#if attention.unacknowledgedSince}<p class="mt-1 text-xs text-(--text-muted)">
					Since {receivedTimeLabel(attention.unacknowledgedSince)} Pacific
				</p>{/if}
			<div class="mt-3 flex flex-wrap items-center gap-3">
				{#if canReply && expectation}<Button
						href="#conversation-reply"
						size="sm"
						onclick={(event) => {
							event.preventDefault();
							const textarea = document.getElementById('reply-body');
							textarea?.scrollIntoView({ block: 'center' });
							textarea?.focus();
						}}>Reply</Button
					>{/if}
				{#if permissions.includes('fionas.communications.acknowledge') && reviewable}
					{#if composerActive}<Button
							type="submit"
							form="conversation-reply-form"
							formaction={acknowledgeAction}
							formnovalidate
							name="throughRecordedOrder"
							value={String(attention.throughRecordedOrder)}
							variant="secondary"
							size="sm"
							disabled={acknowledging || blocked}>Mark as read</Button
						>{:else}<form method="POST" action={acknowledgeAction} use:enhance={acknowledgeSubmit}>
							<input
								type="hidden"
								name="throughRecordedOrder"
								value={attention.throughRecordedOrder}
							/><Button
								type="submit"
								variant="secondary"
								size="sm"
								disabled={acknowledging || blocked}>Mark as read</Button
							>
						</form>{/if}
				{:else if permissions.includes('fionas.communications.acknowledge')}<p
						class="m-0 text-xs text-(--text-muted)"
					>
						Mark as read becomes available once the customer’s messages can be reviewed here.
					</p>
				{/if}
			</div>
		</div>
	{:else if !attention}<p class="mt-3 text-sm text-(--text-muted)">
			Communication attention is unavailable.
		</p>{/if}
	<p class="mt-4 text-sm text-(--text-muted)">{availabilityCopy[availability]}</p>
	{#if newMessage}<div
			class="mt-4 flex flex-wrap items-center gap-3 rounded-input bg-olive-100 p-3 text-sm"
		>
			<span>New customer email · {inquiry.name}</span><Button
				size="sm"
				href={`#message-${newMessage}`}
				onclick={() => {
					const element = document.getElementById(
						`message-${newMessage}`
					) as HTMLDetailsElement | null;
					if (element) {
						element.open = true;
						element.querySelector('summary')?.focus();
					}
				}}>View message</Button
			><Button
				size="sm"
				variant="ghost"
				onclick={() => {
					newMessage = null;
				}}>Dismiss</Button
			>
		</div>{/if}
	{#if timeline}
		<ol class="mt-5 space-y-3" aria-label="Conversation and booking history">
			{#each timeline.items as item (item.id)}<li class="min-w-0">
					{#if item.kind === 'MESSAGE'}<ConversationMessage
							message={item}
							newest={item.messageId === timeline.conversation.latestMessageId}
						/>{:else}<ConversationMilestone {item} {userId} />{/if}
				</li>{/each}
		</ol>
		{#if availability === 'READY' && !timeline.items.some((i) => i.kind === 'MESSAGE')}<p
				class="mt-3 text-sm text-(--text-muted)"
			>
				This conversation exists, with no messages yet.
			</p>{/if}
	{/if}
	{#if canReply}
		{#if expectation && !reply && !recoveryLost}
			<form method="GET" data-sveltekit-reload action={route + '#conversation-reply'} class="mt-4">
				{#if returnContext}<input
						type="hidden"
						name="from"
						value={new URLSearchParams(route.split('?')[1]).get('from') ?? ''}
					/>{/if}
				<Button type="submit">Prepare reply</Button>
			</form>
		{/if}
		<ConversationReply
			{blocked}
			initial={result?.reply ?? reply}
			{expectation}
			recipient={inquiry.email}
			subject={timeline?.conversation.subject}
			action={workspaceAction(returnContext, 'sendConversationReply')}
			lost={result?.recoveryLost ?? recoveryLost}
			{announce}
			acknowledge={acknowledgeSubmit}
			onActiveChange={(active) => {
				composerActive = active;
			}}
		/>{:else}<p class="mt-5 border-t border-olive-200 pt-4 text-sm text-(--text-muted)">
			Reply requires communication read and send permissions.
		</p>{/if}
</Card>
