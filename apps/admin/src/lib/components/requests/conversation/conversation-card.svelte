<script lang="ts">
	import { untrack, tick } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { enhance, applyAction } from '$app/forms';
	import type { ActionResult } from '@sveltejs/kit';
	import { Badge, Button, Card, CloseIcon, capsXs } from '@fionas/ui';
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
	const messages = $derived(timeline?.items.filter((i) => i.kind === 'MESSAGE') ?? []);
	const events = $derived((timeline?.items.length ?? 0) - messages.length);
	const counts = $derived(
		timeline?.items.length
			? `${messages.length} email${messages.length === 1 ? '' : 's'} · ${events} booking event${events === 1 ? '' : 's'}`
			: ''
	);
	const noticed = $derived(messages.find((m) => m.messageId === newMessage));
	const fromQuery = $derived(new URLSearchParams(route.split('?')[1]).get('from') ?? '');
	// The default ring is olive and would vanish on the toast's olive ground.
	const toastFocus =
		'focus-visible:outline-solid focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-cream-200';
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

<Card
	id="conversation"
	class="flex min-w-0 flex-col overflow-hidden p-0"
	data-testid="conversation"
>
	<div class="flex flex-col gap-1 px-[18px] pt-4 pb-3.5">
		<div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
			<h2 class={`m-0 text-(--text-heading) ${capsXs}`}>Conversation</h2>
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
				{#if counts}<span class="text-[11px] text-(--text-muted)">{counts}</span>{/if}
				<form method="GET" action={route + '#conversation'} onsubmit={refresh}>
					{#if returnContext}<input type="hidden" name="from" value={fromQuery} />{/if}
					<Button type="submit" variant="secondary" size="sm" disabled={refreshing}
						>{refreshing ? 'Refreshing…' : 'Refresh conversation'}</Button
					>
				</form>
			</div>
		</div>
		<p class="m-0 mt-1 text-[15px] leading-[1.35] font-semibold wrap-anywhere">
			{timeline?.conversation.subject ?? 'Booking correspondence'}
		</p>
		<p class="m-0 text-xs wrap-anywhere text-(--text-muted)">
			with {inquiry.name} · {inquiry.email}
		</p>
		{#if availability !== 'READY' || !messages.length}<p
				class="m-0 mt-1 text-[12.5px] leading-[1.55] text-(--text-muted)"
			>
				{availability === 'READY'
					? 'This conversation exists, with no messages yet.'
					: availabilityCopy[
							availability
						]}{#if canReply && expectation}{` Your first reply below starts the thread with ${inquiry.name}.`}{/if}
			</p>{/if}
		{#if !attention}<p class="m-0 mt-1 text-[12.5px] text-(--text-muted)">
				Communication attention is unavailable.
			</p>{/if}
	</div>
	<div
		bind:this={statusElement}
		tabindex="-1"
		role="status"
		class="px-[18px] text-[12.5px] leading-[1.55] text-(--text-body)"
	>
		{#if status}<p class="m-0 pb-3.5">{status}</p>{/if}
	</div>
	{#if attention?.needsReply}
		<div
			class="flex flex-wrap items-center gap-x-3 gap-y-2.5 border-t border-rust-600/25 bg-rust-600/8 px-[18px] py-3"
		>
			<div class="flex min-w-0 flex-[1_1_220px] flex-wrap items-center gap-x-2.5 gap-y-1.5">
				<Badge tone="rust" size="sm">Needs reply</Badge>
				<p class="m-0 text-[12.5px] leading-[1.5] text-rust-600">
					<span>Customer message needs attention.</span>
					{#if attention.unacknowledgedSince}<span class="whitespace-nowrap"
							>Since {receivedTimeLabel(attention.unacknowledgedSince)} Pacific</span
						>{/if}
				</p>
			</div>
			<div class="flex flex-wrap items-center gap-2">
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
	{/if}
	{#if timeline?.items.length}
		<ol class="m-0 list-none p-0" aria-label="Conversation and booking history">
			{#each timeline.items as item (item.id)}<li class="min-w-0 border-t border-(--border-soft)">
					{#if item.kind === 'MESSAGE'}<ConversationMessage
							message={item}
							newest={item.messageId === timeline.conversation.latestMessageId}
						/>{:else}<ConversationMilestone {item} {userId} />{/if}
				</li>{/each}
		</ol>
	{/if}
	{#if canReply}
		{#if expectation && !reply && !recoveryLost}
			<form
				method="GET"
				data-sveltekit-reload
				action={route + '#conversation-reply'}
				class="border-t border-(--border-soft) bg-cream-300/50 px-[18px] pt-4"
			>
				{#if returnContext}<input type="hidden" name="from" value={fromQuery} />{/if}
				<Button type="submit">Prepare reply</Button>
			</form>
		{/if}
		<ConversationReply
			{blocked}
			initial={result?.reply ?? reply}
			{expectation}
			recipient={inquiry.email}
			recipientName={inquiry.name}
			subject={timeline?.conversation.subject}
			action={workspaceAction(returnContext, 'sendConversationReply')}
			lost={result?.recoveryLost ?? recoveryLost}
			{announce}
			acknowledge={acknowledgeSubmit}
			onActiveChange={(active) => {
				composerActive = active;
			}}
		/>{:else}<p
			class="m-0 border-t border-(--border-soft) px-[18px] py-4 text-[12.5px] text-(--text-muted)"
		>
			Reply requires communication read and send permissions.
		</p>{/if}
	{#if newMessage}
		<div
			class="toast fixed right-4 bottom-4 z-50 flex w-[340px] max-w-[calc(100vw-32px)] items-start gap-3 rounded-card bg-olive-800 px-4 py-3.5 text-cream-200 shadow-card"
		>
			<div class="flex min-w-0 flex-1 flex-col gap-0.5">
				<span class="text-[13.5px] font-semibold">New customer email · {inquiry.name}</span>
				{#if noticed?.text}<span class="truncate text-[12.5px] opacity-85">{noticed.text}</span
					>{/if}
				<a
					href={`#message-${newMessage}`}
					class={`mt-1.5 self-start rounded-sm text-cream-200 underline underline-offset-2 ${capsXs} ${toastFocus}`}
					onclick={() => {
						const element = document.getElementById(
							`message-${newMessage}`
						) as HTMLDetailsElement | null;
						if (element) {
							element.open = true;
							element.querySelector('summary')?.focus();
						}
					}}>View message</a
				>
			</div>
			<button
				type="button"
				aria-label="Dismiss"
				class={`flex size-7 flex-none cursor-pointer items-center justify-center rounded-full text-cream-200 transition-colors duration-(--dur-fast) ease-(--ease-out) hover:bg-cream-200/15 ${toastFocus}`}
				onclick={() => {
					newMessage = null;
				}}><CloseIcon size={16} /></button
			>
		</div>
	{/if}
</Card>

<style>
	@media (prefers-reduced-motion: no-preference) {
		.toast {
			animation: toast-in var(--dur-med) var(--ease-out);
		}
	}

	@keyframes toast-in {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
</style>
