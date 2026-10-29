<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance, applyAction } from '$app/forms';
	import { Button, focusRing } from '@fionas/ui';
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
		subject,
		action,
		lost,
		blocked,
		announce
	}: {
		initial: ReplyDraft | null;
		expectation: ReplyExpectation | null;
		recipient: string;
		subject?: string | null;
		action: string;
		lost: boolean;
		blocked: boolean;
		announce: (message: string) => void;
	} = $props();
	let draft = $state<ReplyDraft | null>(untrack(() => initial));
	let body = $state(untrack(() => initial?.body ?? ''));
	let pending = $state(false);
	let recoveryLost = $state(untrack(() => lost));
	const locked = $derived(draft?.state !== 'draft');
	const canSubmit = $derived(
		!!draft &&
			!recoveryLost &&
			!pending &&
			!blocked &&
			(draft.state === 'uncertain' || (draft.state === 'draft' && !!expectation))
	);
</script>

<section
	id="conversation-reply"
	class="mt-6 border-t border-olive-200 pt-5"
	aria-labelledby="reply-heading"
>
	<h3 id="reply-heading" class="text-base font-semibold">Reply to customer</h3>
	<p class="mt-2 text-sm wrap-anywhere">To: {recipient}</p>
	{#if subject}<p class="mt-1 text-sm wrap-anywhere text-(--text-muted)">Subject: {subject}</p>{/if}
	{#if recoveryLost}
		<p class="mt-3 text-sm text-rust-600">
			The original send intent is no longer available. Review the conversation and ask an
			administrator to reconcile any possible send. Do not resend the message under a new key.
		</p>
	{:else if draft?.state === 'accepted'}
		<p class="mt-3 text-sm">
			This send intent was already accepted. The different draft below was not sent. Copy it before
			reloading the page to review the conversation.
		</p>
		<p class="mt-3 text-sm wrap-anywhere whitespace-pre-wrap">{body}</p>
	{:else if draft}
		{#if draft.state === 'uncertain'}<p class="mt-3 rounded-input bg-cream-100 p-3 text-sm">
				<strong>Send status not yet confirmed.</strong> The original reply is locked. Reconcile repeats
				its exact key, message and original conversation expectation. It does not create a new email.
			</p>{/if}
		<form
			method="POST"
			{action}
			class="mt-3 space-y-3"
			use:enhance={({ cancel, formData }) => {
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
			<label for="reply-body" class="block text-sm font-semibold">Message</label>
			<textarea
				id="reply-body"
				name="body"
				rows="7"
				maxlength="5000"
				required
				readonly={locked}
				bind:value={body}
				class={`w-full rounded-input border border-olive-300 bg-(--surface-card) p-3 text-sm leading-relaxed wrap-anywhere ${focusRing}`}
				onkeydown={(event) => {
					if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && canSubmit) {
						event.preventDefault();
						event.currentTarget.form?.requestSubmit();
					}
				}}></textarea>
			<p class="text-xs text-(--text-muted)">
				Plain text · {body.length}/5,000 characters. Your staff signature is added automatically.
			</p>
			{#if draft.state === 'rejected' && expectation}
				{#if expectation.expectedLatestMessageId}<input
						type="hidden"
						name="expectedLatestMessageId"
						value={expectation.expectedLatestMessageId}
					/>{:else}<input type="hidden" name="expectEmptyConversation" value="true" />{/if}
				<p class="text-sm">
					Review the messages above before preparing a new send intent. Your draft will be kept for
					editing.
				</p>
				<Button type="submit" name="mode" value="review" disabled={pending || blocked}
					>I reviewed the conversation — edit reply</Button
				>
			{:else}<Button type="submit" disabled={!canSubmit}
					>{pending
						? 'Submitting…'
						: draft.state === 'uncertain'
							? 'Reconcile original reply'
							: 'Send reply'}</Button
				>{/if}
		</form>
		<p class="mt-3 text-xs text-(--text-muted)">
			Unconfirmed replies are kept for up to two hours in this admin session. A restart or expired
			recovery record requires administrator review; never resend an unresolved reply with a new
			key.
		</p>
	{:else}<p class="mt-3 text-sm text-(--text-muted)">
			Reply is unavailable until an accessible conversation can be reviewed.
		</p>{/if}
</section>
