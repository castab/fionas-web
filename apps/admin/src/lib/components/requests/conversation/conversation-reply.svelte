<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance, applyAction } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { Button, Textarea, capsXs } from '@fionas/ui';
	import type {
		ConversationActionResult,
		ReplyDraft,
		ReplyExpectation
	} from '$lib/conversation-contract.js';
	import { replyBody } from '$lib/conversation.js';
	let {
		initial,
		expectation,
		recipient,
		recipientName,
		subject,
		action,
		lost,
		blocked,
		announce,
		acknowledge,
		onActiveChange
	}: {
		initial: ReplyDraft | null;
		expectation: ReplyExpectation | null;
		recipient: string;
		recipientName: string;
		subject?: string | null;
		action: string;
		lost: boolean;
		blocked: boolean;
		announce: (message: string) => void;
		/** Mark as read may submit through this form (keeping its text); the card handles it. */
		acknowledge: SubmitFunction;
		onActiveChange: (active: boolean) => void;
	} = $props();
	let draft = $state<ReplyDraft | null>(untrack(() => initial));
	let body = $state(untrack(() => initial?.body ?? ''));
	let pending = $state(false);
	let recoveryLost = $state(untrack(() => lost));
	const locked = $derived(draft?.state !== 'draft');
	$effect(() => {
		onActiveChange(!recoveryLost && !!draft && draft.state !== 'accepted');
	});
	const canSubmit = $derived(
		!!draft &&
			!recoveryLost &&
			!pending &&
			!blocked &&
			(draft.state === 'uncertain' || (draft.state === 'draft' && !!expectation))
	);
	const notice = 'm-0 rounded-input bg-(--surface-card) p-3 text-[12.5px] leading-[1.55]';
</script>

<section
	id="conversation-reply"
	class="flex flex-col gap-2.5 border-t border-(--border-soft) bg-cream-300/50 px-[18px] py-4"
	aria-labelledby="reply-heading"
>
	<div class="flex flex-col gap-0.5">
		<h3 id="reply-heading" class={`m-0 text-(--text-heading) ${capsXs}`}>Reply</h3>
		<p class="m-0 text-[11.5px] wrap-anywhere text-(--text-muted)">
			To {recipientName} · {recipient}{#if subject}{` · Re: ${subject}`}{/if}
		</p>
	</div>
	{#if recoveryLost}
		<p class={`${notice} text-rust-600`}>
			The original send intent is no longer available. Review the conversation and ask an
			administrator to reconcile any possible send. Do not resend the message under a new key.
		</p>
	{:else if draft?.state === 'accepted'}
		<p class={notice}>
			This send intent was already accepted. The different draft below was not sent. Copy it before
			reloading the page to review the conversation.
		</p>
		<p class="m-0 text-[13.5px] leading-[1.65] wrap-anywhere whitespace-pre-wrap">{body}</p>
	{:else if draft}
		{#if draft.state === 'uncertain'}<p class={notice}>
				<strong>Send status not yet confirmed.</strong> The original reply is locked. Reconcile repeats
				its exact key, message and original conversation expectation. It does not create a new email.
			</p>{/if}
		<form
			id="conversation-reply-form"
			method="POST"
			{action}
			class="flex flex-col gap-2.5"
			use:enhance={(input) => {
				const { cancel, formData } = input;
				if (input.action.search.includes('/acknowledgeConversation')) return acknowledge(input);
				if (pending || blocked || !draft) {
					cancel();
					return;
				}
				const reviewing = formData.get('mode') === 'review';
				if (!reviewing && !replyBody(body)) {
					cancel();
					announce('Enter a plain-text reply of 1–5,000 characters.');
					return;
				}
				pending = true;
				if (!reviewing) draft = { ...draft, body: body.trim(), state: 'uncertain' };
				return async ({ result }) => {
					pending = false;
					if (result.type === 'redirect') {
						await applyAction(result);
						return;
					}
					if (result.type === 'failure' || result.type === 'success') {
						const data = result.data as ConversationActionResult | undefined;
						if (data?.reply) {
							draft = data.reply;
							body = data.reply.body;
						}
						recoveryLost = !!data?.recoveryLost;
						announce(
							data?.conversationError ??
								(reviewing
									? 'Conversation reviewed. Check your draft, then send when ready.'
									: 'Send status not yet confirmed. Reconcile the original reply.')
						);
					} else {
						announce(
							'Send status not yet confirmed. Refresh to recover the original intent, or reconcile it unchanged. Do not send again with a new key.'
						);
					}
				};
			}}
		>
			<input type="hidden" name="key" value={draft.key} />
			<label for="reply-body" class="sr-only">Message</label>
			<Textarea
				id="reply-body"
				name="body"
				rows={5}
				maxlength={5000}
				required
				readonly={locked}
				placeholder="Write your reply…"
				aria-describedby={draft.state === 'rejected' && expectation ? undefined : 'reply-hint'}
				bind:value={body}
				class="min-h-24 border-(--border-soft) bg-(--surface-card) text-sm leading-[1.55] wrap-anywhere read-only:opacity-80"
				onkeydown={(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) => {
					if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && canSubmit) {
						event.preventDefault();
						event.currentTarget.form?.requestSubmit();
					}
				}}
			/>
			{#if draft.state === 'rejected' && expectation}
				{#if expectation.expectedLatestMessageId}<input
						type="hidden"
						name="expectedLatestMessageId"
						value={expectation.expectedLatestMessageId}
					/>{:else}<input type="hidden" name="expectEmptyConversation" value="true" />{/if}
				<p class="m-0 text-[12.5px]">
					Review the messages above before preparing a new send intent. Your draft will be kept for
					editing.
				</p>
				<div>
					<Button type="submit" name="mode" value="review" disabled={pending || blocked}
						>I reviewed the conversation — edit reply</Button
					>
				</div>
			{:else}<div class="flex flex-wrap items-center gap-3">
					<Button type="submit" disabled={!canSubmit}
						>{pending
							? 'Submitting…'
							: draft.state === 'uncertain'
								? 'Reconcile original reply'
								: 'Send reply'}</Button
					>
					<p id="reply-hint" class="m-0 text-[10.5px] leading-[1.4] text-(--text-muted)">
						Plain text · {body.length}/5,000 · Signature added automatically · Ctrl+Enter or ⌘+Enter
						to send
					</p>
				</div>{/if}
		</form>
		{#if draft.state !== 'draft'}<p class="m-0 text-[11px] text-(--text-muted)">
				Unconfirmed replies are kept for up to two hours in this admin session. A restart or expired
				recovery record requires administrator review; never resend an unresolved reply with a new
				key.
			</p>{/if}
	{:else}<p class="m-0 text-[12.5px] text-(--text-muted)">
			Reply is unavailable until an accessible conversation can be reviewed.
		</p>{/if}
</section>
