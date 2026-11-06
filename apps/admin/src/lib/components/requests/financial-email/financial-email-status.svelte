<script lang="ts">
	import { cn } from '@fionas/ui';
	import type {
		FinancialEmailHistory,
		FinancialEmailKind,
		FinancialEmailView
	} from '$lib/financial-email-contract.js';
	import {
		acceptedNoticeCopy,
		customerFirstName,
		draftLocked,
		emailCopy,
		emailDeliveryLabels,
		emailedVersionLabel,
		kindLabel,
		missingEmailPermissionCopy,
		pacificTimeLabel,
		unavailableCopy,
		type FinancialEmailStatus
	} from '$lib/financial-email.js';

	let {
		view,
		status,
		historyLoaded,
		userId,
		customerName,
		accepted = null,
		activityHref = '#conversation'
	}: {
		view: FinancialEmailView;
		/** From the live timeline's `financialEmails`; null when the timeline did not load. */
		status: FinancialEmailStatus | null;
		historyLoaded: boolean;
		userId: string;
		customerName: string;
		/** A send this page just saw accepted (enhanced), else the one-time notice after the PRG. */
		accepted?: { sendId: string; replayed: boolean; kind: FinancialEmailKind } | null;
		/** The sent email's Activity message once it has arrived, else Activity itself. */
		activityHref?: string;
	} = $props();
	// Status only: the Email quote / Email invoice action lives in Right now's action rows.
	const name = $derived(kindLabel(view.kind));
	const first = $derived(customerFirstName(customerName));
	const locked = $derived(draftLocked(view.draft));
	const who = (r: FinancialEmailHistory) => (r.actor.principalId === userId ? 'you' : 'staff');
	const when = (r: FinancialEmailHistory) => pacificTimeLabel(r.acceptedAt ?? r.requestedAt);
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
	const lostSendId = $derived(
		status?.unknown.findLast((r) => r.actor.principalId === userId)?.sendId ??
			status?.unknown.at(-1)?.sendId ??
			null
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
	{#if !historyLoaded || !status}
		<p class="m-0 text-[12.5px] leading-[1.5] text-(--text-muted)">
			Email history is unavailable, so whether this {name} was emailed can’t be shown.
		</p>
	{:else}
		{#if status.summary === 'current' && status.current}
			<p class="m-0 text-[12.5px] leading-[1.5]" data-testid="financial-email-summary">
				{emailCopy.current(view.kind, first, when(status.current), who(status.current))}
			</p>
			<div class="flex flex-wrap gap-1.5">
				{#each emailDeliveryLabels(status.current) as label (label)}<span
						class={cn(chip, tone(label))}>{label}</span
					>{/each}
			</div>
		{:else if status.summary === 'earlier' && status.latest}
			<p class="m-0 text-[12.5px] leading-[1.5]" data-testid="financial-email-summary">
				{emailCopy.earlier(view.kind, emailedVersionLabel(status.latest), when(status.latest))}
			</p>
		{:else if status.summary === 'never'}
			<p class="m-0 text-[12.5px] leading-[1.5]" data-testid="financial-email-summary">
				{emailCopy.never(view.kind)}
			</p>
		{/if}
		{#each status.unknown as record (record.sendId)}
			<p
				class="m-0 rounded-input border border-rust-600/30 bg-rust-600/8 px-3 py-2 text-[12.5px] leading-[1.5] text-rust-600"
				data-testid="financial-email-unknown"
			>
				<strong>{emailCopy.unknown(view.kind, pacificTimeLabel(record.requestedAt))}</strong>
				{emailCopy.unknownNext(locked && who(record) === 'you')}
				<span class="block text-[11px] wrap-anywhere">Send ID {record.sendId}</span>
			</p>
		{/each}
		{#if status.rejected}
			<p
				class="m-0 text-[12px] leading-[1.5] text-(--text-muted)"
				data-testid="financial-email-rejected-status"
			>
				{emailCopy.rejected(pacificTimeLabel(status.rejected.requestedAt))}
			</p>
		{/if}
	{/if}
	{#if accepted}
		<!-- Shown once: after an enhanced send closes the panel, or after the native redirect. -->
		<p
			id="financial-email-accepted"
			tabindex="-1"
			role="status"
			class="m-0 rounded-input border border-moss-600/30 bg-moss-600/10 px-3 py-2 text-[12.5px] leading-[1.5] focus:outline-none"
			data-testid="financial-email-accepted"
		>
			{acceptedNoticeCopy(accepted.kind, accepted.replayed)}
			<!-- eslint-disable svelte/no-navigation-without-resolve -- an in-page fragment -->
			<a href={activityHref} class="font-semibold text-(--text-body) underline"
				>See it in Activity</a
			>{accepted.replayed ? '.' : '; it shows as delivered once the email provider confirms.'}
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		</p>
	{/if}
	{#if view.lost}
		<p class="m-0 text-[12px] leading-[1.5] text-rust-600" data-testid="financial-email-lost">
			{emailCopy.lost(lostSendId)}
		</p>
	{:else if view.unavailable && !locked}
		<p
			class="m-0 text-[12px] leading-[1.5] text-(--text-muted)"
			data-testid="financial-email-unavailable"
		>
			{unavailableCopy[view.unavailable]}
		</p>
	{:else if !view.canManage}
		<p
			class="m-0 text-[11.5px] leading-[1.5] text-(--text-muted)"
			data-testid="financial-email-permissions"
		>
			{missingEmailPermissionCopy}
		</p>
	{/if}
</section>
