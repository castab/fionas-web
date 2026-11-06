<script lang="ts">
	import { Button, cn } from '@fionas/ui';
	import type {
		FinancialEmailHistory,
		FinancialEmailKind,
		FinancialEmailView
	} from '$lib/financial-email-contract.js';
	import {
		draftLocked,
		emailDeliveryLabels,
		emailedVersionLabel,
		kindLabel,
		unavailableCopy,
		type FinancialEmailStatus
	} from '$lib/financial-email.js';
	import { receivedTimeLabel } from '$lib/payments.js';

	let {
		view,
		status,
		historyLoaded,
		userId,
		href,
		disabled = false,
		accepted = null
	}: {
		view: FinancialEmailView;
		/** From the live timeline's `financialEmails`; null when the timeline did not load. */
		status: FinancialEmailStatus | null;
		historyLoaded: boolean;
		userId: string;
		/** Opens (or scrolls to) the email review panel. */
		href: string;
		disabled?: boolean;
		/** A send this page just saw accepted (enhanced), else the one-time notice after the PRG. */
		accepted?: { sendId: string; replayed: boolean; kind: FinancialEmailKind } | null;
	} = $props();
	const name = $derived(kindLabel(view.kind));
	const locked = $derived(draftLocked(view.draft));
	const who = (r: FinancialEmailHistory) => (r.actor.principalId === userId ? 'you' : 'staff');
	const when = (r: FinancialEmailHistory) => receivedTimeLabel(r.acceptedAt ?? r.requestedAt);
	const chip =
		'inline-flex items-center rounded-full px-2.5 py-1 font-sans text-[10px] leading-[1.4] font-semibold tracking-(--track-caps-tight) uppercase';
	const tone = (label: string) =>
		/unknown|Rejected|Bounced|failed|Failed|spam|suppressed|uncertain/.test(label)
			? 'bg-rust-600/12 text-rust-600'
			: label === 'Delivered'
				? 'bg-moss-600/18 text-olive-900'
				: 'bg-olive-700/12 text-olive-800';
	const micro =
		'm-0 font-sans text-[9.5px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-muted) uppercase';
	const offer = $derived(
		view.canManage && (locked || (!!view.intent && !view.unavailable && !view.lost))
	);
</script>

<section
	id="financial-email-status"
	aria-labelledby="financial-email-status-title"
	class="flex flex-col gap-2 border-t border-(--border-soft) pt-3"
	data-testid="financial-email-status"
>
	<!-- A label like Right now’s own, not a heading: the card keeps one headline. -->
	<p id="financial-email-status-title" class={micro}>Customer email</p>
	{#if accepted}
		<p
			role="status"
			class="m-0 rounded-input border border-moss-600/30 bg-moss-600/10 px-3 py-2 text-[12.5px] leading-[1.5]"
			data-testid="financial-email-accepted"
		>
			{accepted.replayed
				? `This ${kindLabel(accepted.kind)} email was already accepted earlier; no new email was sent.`
				: `${kindLabel(accepted.kind)} email accepted by the email provider.`} Delivery is not confirmed
			until the provider reports it in Activity.
		</p>
	{/if}
	{#if !historyLoaded || !status}
		<p class="m-0 text-[12.5px] leading-[1.5] text-(--text-muted)">
			Email history is unavailable, so whether this {name} was emailed can’t be shown.
		</p>
	{:else}
		{#if status.summary === 'current' && status.current}
			<p class="m-0 text-[12.5px] leading-[1.5]" data-testid="financial-email-summary">
				Current {name} emailed {when(status.current)} Pacific by {who(status.current)}.
			</p>
			<div class="flex flex-wrap gap-1.5">
				{#each emailDeliveryLabels(status.current) as label (label)}<span
						class={cn(chip, tone(label))}>{label}</span
					>{/each}
			</div>
		{:else if status.summary === 'earlier' && status.latest}
			<p class="m-0 text-[12.5px] leading-[1.5]" data-testid="financial-email-summary">
				Only an earlier {name} was emailed ({emailedVersionLabel(status.latest)},
				{when(status.latest)} Pacific). The current {name} hasn’t been emailed.
			</p>
		{:else if status.summary === 'never'}
			<p class="m-0 text-[12.5px] leading-[1.5]" data-testid="financial-email-summary">
				This {name} hasn’t been emailed. {view.kind === 'QUOTE'
					? 'Publishing a Quote never emails it.'
					: 'Marking served never emails it.'}
			</p>
		{/if}
		{#each status.unknown as record (record.sendId)}
			<p
				class="m-0 rounded-input border border-rust-600/30 bg-rust-600/8 px-3 py-2 text-[12.5px] leading-[1.5] text-rust-600"
				data-testid="financial-email-unknown"
			>
				<strong>Send outcome unknown</strong> for {emailedVersionLabel(record)}, requested {receivedTimeLabel(
					record.requestedAt
				)} Pacific by {who(record)}. It may have been sent. {locked && who(record) === 'you'
					? 'Reconcile the original send below.'
					: 'Only the original command can reconcile it; do not send another.'}
				<span class="block text-[11px] wrap-anywhere">Send ID {record.sendId}</span>
			</p>
		{/each}
		{#if status.rejected}
			<p class="m-0 text-[12px] leading-[1.5] text-(--text-muted)">
				The latest attempt ({receivedTimeLabel(status.rejected.requestedAt)} Pacific) was rejected by
				the email provider; it was not sent.
			</p>
		{/if}
	{/if}
	{#if view.lost}
		<p class="m-0 text-[12px] leading-[1.5] text-rust-600" data-testid="financial-email-lost">
			The original command for an unresolved email is not available in this browser. Do not prepare
			a new email: ask an administrator to investigate with the send ID.
		</p>
	{:else if view.unavailable && !locked}
		<p
			class="m-0 text-[12px] leading-[1.5] text-(--text-muted)"
			data-testid="financial-email-unavailable"
		>
			{unavailableCopy[view.unavailable]}
		</p>
	{:else if !view.canManage}
		<p class="m-0 text-[11.5px] leading-[1.5] text-(--text-muted)">
			Emailing requires inquiry and financial-document read, communications read and send, and
			payment-access manage permissions.
		</p>
	{/if}
	{#if offer}
		<div>
			<Button
				{href}
				variant="secondary"
				size="sm"
				{disabled}
				class="aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
				data-testid="open-financial-email"
				>{locked ? 'Review unresolved email' : `Email ${name.toLowerCase()}`}</Button
			>
		</div>
	{/if}
</section>
