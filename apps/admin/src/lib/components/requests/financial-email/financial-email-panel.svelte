<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { Button, Card, cn, focusRing } from '@fionas/ui';
	import type { StaffTimeline } from '$lib/conversation-contract.js';
	import type {
		FinancialEmailActionResult,
		FinancialEmailDraft,
		FinancialEmailKind,
		FinancialEmailPreview,
		FinancialEmailView
	} from '$lib/financial-email-contract.js';
	import {
		MESSAGE_MAX_LENGTH,
		draftLocked,
		expectationFields,
		financialEmailMessage,
		financialEmailStatus,
		financialEmailTarget,
		intentVersionLabel,
		kindLabel,
		messageProblemCopy,
		sameIntent,
		unavailableCopy
	} from '$lib/financial-email.js';
	import { replyExpectation } from '$lib/conversation.js';
	import { formatMoney } from '$lib/presentation.js';
	import { receivedTimeLabel } from '$lib/payments.js';
	import { workspaceAction, type RequestListQuery } from '$lib/request-list.js';
	import type { CurrentStaffRequest } from '$lib/request-contract.js';
	import EmailPreviewFrame from './email-preview-frame.svelte';

	let {
		view,
		result = null,
		request,
		timeline,
		route,
		returnContext = null,
		blocked = false,
		detailsChanged = false,
		focusOnOpen = false,
		onaccepted
	}: {
		view: FinancialEmailView;
		/** A native (no-JS) action result; enhanced results are applied here without `form`. */
		result?: FinancialEmailActionResult['financialEmail'] | null;
		/** The live authoritative projection: a changed document invalidates the preview. */
		request: CurrentStaffRequest;
		/** The live Activity timeline: new correspondence invalidates the preview. */
		timeline: StaffTimeline | null;
		route: string;
		returnContext?: RequestListQuery | null;
		/** Another workspace mutation needs review first. */
		blocked?: boolean;
		/** The page could not re-read changed request details. */
		detailsChanged?: boolean;
		focusOnOpen?: boolean;
		/** An enhanced send was accepted (201) or confirmed as a replay (200). */
		onaccepted: (detail: { sendId: string; replayed: boolean; kind: FinancialEmailKind }) => void;
	} = $props();

	let draft = $state<FinancialEmailDraft | null>(
		untrack(() => (result && 'draft' in result ? (result.draft ?? null) : view.draft))
	);
	let preview = $state<FinancialEmailPreview | null>(
		untrack(() => result?.preview ?? view.preview)
	);
	let message = $state(untrack(() => result?.message ?? draft?.message ?? ''));
	let error = $state(untrack(() => result?.error ?? view.error ?? ''));
	let serverStale = $state(untrack(() => !!result?.stale || view.stale));
	let lost = $state(untrack(() => !!result?.lost || view.lost));
	let pending = $state<'preview' | 'send' | null>(null);
	let hydrated = $state(false);
	let messageElement = $state<HTMLTextAreaElement>();
	let errorElement = $state<HTMLParagraphElement>();
	let statusElement = $state<HTMLParagraphElement>();
	let status = $state('');
	onMount(() => {
		hydrated = true;
		if (focusOnOpen && !error) messageElement?.focus();
	});

	const name = $derived(kindLabel(view.kind));
	const target = $derived(financialEmailTarget(request));
	const intent = $derived(target && 'intent' in target ? target.intent : null);
	const expectation = $derived(replyExpectation(timeline));
	const locked = $derived(draftLocked(draft));
	const normalized = $derived(financialEmailMessage(message));
	const history = $derived(financialEmailStatus(timeline?.financialEmails, view.kind));
	// The reviewed email stays reviewable only while nothing it binds has changed.
	const changedMessage = $derived(
		!!draft && (!normalized.ok || normalized.message !== draft.message)
	);
	const changedDocument = $derived(!!draft && !sameIntent(draft.intent, intent));
	const changedConversation = $derived(
		!!draft &&
			!!expectation &&
			((draft.expectation.expectedLatestMessageId ?? null) !==
				(expectation.expectedLatestMessageId ?? null) ||
				!!draft.expectation.expectEmptyConversation !== !!expectation.expectEmptyConversation)
	);
	const reviewed = $derived(
		!!draft &&
			draft.state === 'reviewed' &&
			!locked &&
			!!preview &&
			!serverStale &&
			!changedMessage &&
			!changedDocument &&
			!changedConversation &&
			!detailsChanged
	);
	const invalidation = $derived(
		!draft || draft.state !== 'reviewed' || locked
			? null
			: changedDocument || detailsChanged || serverStale
				? `The ${name} or its payment details changed since this preview. Preview the email again before sending.`
				: changedConversation
					? 'New correspondence arrived since this preview. Check Activity, then preview the email again.'
					: changedMessage
						? 'You changed the message after the preview. Preview the email again to review it.'
						: null
	);
	const unavailable = $derived(
		target && 'unavailable' in target
			? target.unavailable
			: history.unknown.length && !locked
				? ('unresolved' as const)
				: !expectation && !locked
					? ('conversation' as const)
					: view.unavailable === 'storage'
						? view.unavailable
						: undefined
	);
	const canPreview = $derived(
		view.canManage && !locked && !lost && !!intent && !!expectation && !unavailable && !pending
	);
	const canSend = $derived(view.canManage && reviewed && !pending && !blocked && !lost);
	const canReconcile = $derived(
		view.canManage &&
			locked &&
			draft?.state !== 'reconciliation_required' &&
			!pending &&
			!blocked &&
			!lost
	);
	const previewAction = $derived(workspaceAction(returnContext, 'previewFinancialEmail', 'email'));
	const sendAction = $derived(workspaceAction(returnContext, 'sendFinancialEmail', 'email'));
	const fields = $derived(intent ?? draft?.intent ?? null);

	async function announce(text: string, alert = false) {
		if (alert) {
			error = text;
			await tick();
			errorElement?.focus();
		} else {
			status = text;
			await tick();
			statusElement?.focus();
		}
	}

	const submit: SubmitFunction = ({ action, cancel }) => {
		const sending = action.search.includes('sendFinancialEmail');
		if (pending || (sending ? !(canSend || canReconcile) : !canPreview)) {
			cancel();
			return;
		}
		if (!sending && !normalized.ok) {
			cancel();
			void announce(messageProblemCopy[normalized.problem], true);
			messageElement?.focus();
			return;
		}
		error = '';
		status = '';
		pending = sending ? 'send' : 'preview';
		// Once a send may occur the reviewed email is locked, before any response arrives.
		if (sending && draft?.state === 'reviewed') draft = { ...draft, state: 'attempted' };
		return async ({ result }) => {
			pending = null;
			if (result.type === 'success' || result.type === 'failure') {
				const data = (result.data as FinancialEmailActionResult | undefined)?.financialEmail;
				const accepted = data?.accepted;
				if (accepted) {
					draft = null;
					preview = null;
					message = '';
					serverStale = false;
					onaccepted(accepted);
					await announce(
						accepted.replayed
							? `This ${name} email was already accepted earlier; no new email was sent.`
							: `${name} email accepted by the email provider. Delivery is not confirmed yet.`
					);
					return;
				}
				if (data && 'draft' in data && data.draft !== undefined) draft = data.draft;
				if (data?.preview !== undefined) preview = data.preview;
				if (data?.message !== undefined && !locked) message = data.message;
				serverStale = !!data?.stale;
				lost = !!data?.lost;
				if (result.type === 'success') {
					await announce(`Preview ready. Review the email below, then send it when ready.`);
					document.getElementById('financial-email-review')?.scrollIntoView({ block: 'nearest' });
				} else await announce(data?.error ?? 'The request was not confirmed.', true);
			} else if (result.type === 'redirect') {
				// Native-equivalent PRG: navigate so the authoritative GET shows the outcome.
				window.location.assign(result.location);
			} else {
				// No classified answer. A send may have happened: keep its exact command locked.
				if (sending && draft) draft = { ...draft, state: 'unknown' };
				await announce(
					sending
						? 'The send could not be confirmed. It may have been sent. Use Reconcile original send, which repeats the exact original command.'
						: 'The preview is unavailable right now. Try again shortly.',
					true
				);
			}
		};
	};
	const caps =
		'm-0 font-sans text-[11px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-heading) uppercase';
	const micro =
		'm-0 font-sans text-[9.5px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-muted) uppercase';
	const notice = 'm-0 rounded-input px-3 py-2.5 text-[12.5px] leading-[1.55]';
	const subject = $derived(preview?.subject ?? timeline?.conversation.subject ?? null);
</script>

<Card
	variant="flat"
	id="financial-email"
	role="region"
	aria-labelledby="financial-email-title"
	class="flex min-w-0 flex-col gap-4 border-2 border-olive-700 p-[18px] sm:p-5"
	data-testid="financial-email-panel"
>
	<div class="flex flex-col gap-1.5">
		<h2 id="financial-email-title" class={caps}>Email {name.toLowerCase()}</h2>
		<p class="m-0 text-xs leading-[1.55] text-(--text-muted)">
			{view.kind === 'QUOTE'
				? 'Emails the current published Quote, with the customer’s payment link, in the booking’s email thread. Publishing a Quote never sends it; this does, only when you click Send quote.'
				: 'Emails the current Invoice and its remaining balance, with the customer’s payment link, in the booking’s email thread. Only you sending it here emails it.'}
			This is not a conversation reply and records no payment.
		</p>
	</div>

	<p
		bind:this={statusElement}
		tabindex="-1"
		role="status"
		class={cn('m-0 text-[12.5px] leading-[1.55]', !status && 'sr-only')}
		data-testid="financial-email-status-message"
	>
		{status}
	</p>
	{#if error}
		<p
			bind:this={errorElement}
			tabindex="-1"
			role="alert"
			class="m-0 text-sm leading-[1.5] text-rust-600"
			data-testid="financial-email-error"
		>
			{error}
		</p>
	{/if}

	{#if lost}
		<p class={cn(notice, 'bg-rust-600/8 text-rust-600')} data-testid="financial-email-lost">
			The original command for an unresolved email is not available in this browser, so it cannot be
			reconciled here. Do not prepare a new email. Ask an administrator to investigate with the send
			ID shown under Customer email.
		</p>
	{:else if draft?.state === 'reconciliation_required'}
		<p
			class={cn(notice, 'bg-rust-600/8 text-rust-600')}
			data-testid="financial-email-reconciliation"
		>
			<strong>Reconciliation required.</strong> Commerce cannot reconstruct this email exactly, so
			it will not dispatch it. The customer may or may not have received it. Investigate provider
			acceptance and delivery{draft.sendId ? ` with send ID ${draft.sendId}` : ''}; never assume it
			was not sent.
		</p>
	{:else if locked && draft}
		<p class={cn(notice, 'bg-rust-600/8 text-(--text-body)')} data-testid="financial-email-locked">
			<strong>Send outcome unknown.</strong>
			{draft.possiblyAttempted
				? 'Commerce has a matching send request from after this review, so it may already have been sent.'
				: 'It may have been sent.'} The reviewed email is locked. Reconcile original send repeats its
			exact key, message, review and original conversation expectation: if it was already sent, nothing
			new is sent; if it never reached the email provider, this sends it now.
		</p>
	{:else if draft?.state === 'rejected'}
		<p class={cn(notice, 'bg-cream-200')} data-testid="financial-email-rejected">
			The last send was refused, and nothing is pending under it. Review the email again to start a
			new send.
		</p>
	{/if}

	{#if history.current && !locked}
		<p class={cn(notice, 'bg-olive-700/8')} data-testid="financial-email-already">
			This {name} was already emailed {receivedTimeLabel(
				history.current.acceptedAt ?? history.current.requestedAt
			)} Pacific. Sending again emails the customer again.
		</p>
	{/if}

	<dl class="m-0 grid grid-cols-1 gap-x-4 gap-y-3 min-[480px]:grid-cols-2">
		<div class="min-w-0">
			<dt class={micro}>To</dt>
			<dd
				class="m-0 mt-0.5 text-[13.5px] font-semibold wrap-anywhere"
				data-testid="email-recipient"
			>
				{preview?.recipientName ?? request.inquiry.name}
				<span class="block text-[12px] font-normal text-(--text-muted)"
					>{preview?.recipientAddress ?? request.inquiry.email}</span
				>
			</dd>
		</div>
		<div class="min-w-0">
			<dt class={micro}>Thread</dt>
			<dd class="m-0 mt-0.5 text-[13px] wrap-anywhere">
				{#if (draft?.expectation ?? expectation)?.expectedLatestMessageId}Replies in the existing
					thread{#if subject}: {subject}{/if}{:else if draft || expectation}Starts the booking’s
					email thread{#if subject}: {subject}{/if}{:else}Unavailable{/if}
			</dd>
		</div>
		{#if fields}
			<div class="min-w-0">
				<dt class={micro}>Document (staff only)</dt>
				<dd class="m-0 mt-0.5 text-[13px]" data-testid="email-document">
					{intentVersionLabel(draft?.intent ?? fields)}
				</dd>
			</div>
		{/if}
	</dl>

	{#if unavailable && !locked && !lost}
		<p class={cn(notice, 'bg-cream-200')} data-testid="financial-email-unavailable-panel">
			{unavailableCopy[unavailable]}
		</p>
	{/if}

	{#if !view.canManage}
		<p class={cn(notice, 'bg-cream-200')}>
			Emailing a {name} requires inquiry read, financial-document read, communications read and send,
			and payment-access manage permissions.
		</p>
	{:else if fields}
		<form
			method="POST"
			action={previewAction}
			novalidate
			use:enhance={submit}
			aria-busy={!!pending}
			class="flex flex-col gap-4"
			data-testid="financial-email-form"
		>
			<input type="hidden" name="kind" value={fields.kind} />
			<input type="hidden" name="documentId" value={fields.documentId} />
			<input type="hidden" name="expectedDocumentVersion" value={fields.expectedDocumentVersion} />
			<input
				type="hidden"
				name="expectedBusinessRevision"
				value={fields.expectedBusinessRevision}
			/>
			{#if fields.kind === 'QUOTE'}
				<input type="hidden" name="proposalId" value={fields.proposalId} />
				<input
					type="hidden"
					name="expectedDepositRequirementRevision"
					value={fields.expectedDepositRequirementRevision}
				/>
			{/if}
			{#if expectation}
				{#each Object.entries(expectationFields(expectation)) as [field, value] (field)}
					<input type="hidden" name={field} {value} />
				{/each}
			{/if}
			{#if draft}<input type="hidden" name="reviewId" value={draft.reviewId} />{/if}
			<div class="flex flex-col gap-1.5">
				<label for="financial-email-message" class={caps}>Personal message (optional)</label>
				<textarea
					id="financial-email-message"
					name="message"
					rows="4"
					maxlength={MESSAGE_MAX_LENGTH}
					bind:this={messageElement}
					bind:value={message}
					readonly={locked || lost}
					disabled={!!pending}
					aria-describedby="financial-email-message-help"
					aria-invalid={!normalized.ok ? 'true' : undefined}
					placeholder={`Leave blank for the standard ${name} greeting.`}
					class={`min-h-24 w-full min-w-0 resize-y rounded-input border border-(--border-soft) bg-(--surface-card) px-3 py-2.5 text-sm leading-[1.55] wrap-anywhere read-only:opacity-80 aria-invalid:border-rust-600 ${focusRing}`}
				></textarea>
				<p
					id="financial-email-message-help"
					class="m-0 flex justify-between gap-3 text-xs text-(--text-muted)"
				>
					<span
						>Plain text; blank lines start new paragraphs. Shown to the customer above the {name}.
						Changing it after a preview needs a new preview.</span
					>
					{#if hydrated}<span aria-hidden="true" class="whitespace-nowrap"
							>{message.length}/{MESSAGE_MAX_LENGTH.toLocaleString('en-US')}</span
						>{/if}
				</p>
			</div>

			{#if invalidation}
				<p
					class={cn(notice, 'bg-olive-700/8')}
					role="status"
					data-testid="financial-email-invalidated"
				>
					{invalidation}
				</p>
			{/if}

			{#if preview && draft && !locked && !invalidation}
				<section
					id="financial-email-review"
					aria-labelledby="financial-email-review-title"
					class="flex min-w-0 flex-col gap-3 border-t border-(--border-soft) pt-4"
					data-testid="financial-email-review"
				>
					<h3 id="financial-email-review-title" class={caps}>Review before sending</h3>
					<dl class="m-0 grid grid-cols-1 gap-x-4 gap-y-3 min-[480px]:grid-cols-2">
						<div class="min-w-0 min-[480px]:col-span-2">
							<dt class={micro}>Subject</dt>
							<dd
								class="m-0 mt-0.5 text-[13.5px] font-semibold wrap-anywhere"
								data-testid="email-subject"
							>
								{preview.subject}
							</dd>
						</div>
						<div>
							<dt class={micro}>{name} total</dt>
							<dd class="m-0 mt-0.5 text-[15px] font-bold" data-testid="email-total">
								{formatMoney(preview.financial.total, 'USD')}
							</dd>
						</div>
						<div>
							<dt class={micro}>{view.kind === 'QUOTE' ? 'Deposit due now' : 'Amount due now'}</dt>
							<dd class="m-0 mt-0.5 text-[15px] font-bold" data-testid="email-required">
								{formatMoney(preview.requiredPayment, 'USD')}
							</dd>
						</div>
						<div>
							<dt class={micro}>Paid</dt>
							<dd class="m-0 mt-0.5 text-[13.5px]" data-testid="email-paid">
								{formatMoney(preview.paidAmount, 'USD')}
							</dd>
						</div>
						<div>
							<dt class={micro}>Remaining balance</dt>
							<dd class="m-0 mt-0.5 text-[13.5px]" data-testid="email-balance">
								{formatMoney(preview.balance, 'USD')}
							</dd>
						</div>
						{#if preview.balanceAfterDeposit != null}
							<div>
								<dt class={micro}>Balance after deposit</dt>
								<dd class="m-0 mt-0.5 text-[13.5px]" data-testid="email-after-deposit">
									{formatMoney(preview.balanceAfterDeposit, 'USD')}
								</dd>
							</div>
						{/if}
					</dl>
					<EmailPreviewFrame html={preview.html} text={preview.text} subject={preview.subject} />
					<p class="m-0 text-[11.5px] leading-[1.5] text-(--text-muted)">
						The sent email carries the customer’s own payment link instead of the inert preview
						button. Customers never see version numbers.
					</p>
				</section>
			{/if}

			<div class="flex flex-wrap gap-2.5">
				{#if locked && draft}
					<Button
						type="submit"
						formaction={sendAction}
						disabled={!canReconcile}
						class="min-h-12 flex-[1.4_1_180px]"
						data-testid="reconcile-financial-email"
						>{pending === 'send' ? 'Reconciling…' : 'Reconcile original send'}</Button
					>
				{:else}
					<Button
						type="submit"
						variant={reviewed ? 'secondary' : 'primary'}
						disabled={!canPreview}
						class="min-h-12 flex-[1_1_150px]"
						data-testid="preview-financial-email"
						>{pending === 'preview'
							? 'Preparing preview…'
							: draft
								? 'Preview again'
								: 'Preview email'}</Button
					>
					{#if reviewed}<Button
							type="submit"
							formaction={sendAction}
							disabled={!canSend}
							class="min-h-12 flex-[1.4_1_150px]"
							data-testid="send-financial-email"
							>{pending === 'send' ? 'Sending…' : `Send ${name.toLowerCase()}`}</Button
						>{/if}
				{/if}
				{#if !pending && !locked}<Button
						href={route}
						variant="ghost"
						class="min-h-12 flex-[0_1_100px]"
						data-testid="close-financial-email">Close</Button
					>{/if}
			</div>
			{#if draft && draft.state !== 'reviewed'}
				<p class="m-0 text-[11px] leading-[1.5] text-(--text-muted)">
					Reviewed {receivedTimeLabel(draft.reviewedAt)} Pacific{draft.sendId
						? ` · Send ID ${draft.sendId}`
						: ''}. The original command is kept encrypted in this browser for 30 days; reconcile
					before then. A new key is never used to retry it.
				</p>
			{/if}
		</form>
	{/if}
</Card>
