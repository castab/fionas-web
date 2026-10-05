<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { Badge, Button, Card, focusRing } from '@fionas/ui';
	import { site } from '@fionas/shared';
	import RequestDetails from '$lib/components/requests/request-details.svelte';
	import FinancialDocumentCard from '$lib/components/requests/financial-document-card.svelte';
	import {
		eventDateLabel,
		eventTypeLabel,
		formatMoney,
		submittedDateLabel
	} from '$lib/presentation.js';
	import {
		canIssueQuote,
		financialStageLabel,
		lifecycleLabel,
		lifecycleStages,
		requestErrorMessage,
		requestSummary
	} from '$lib/request-workspace.js';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let submitting = $state(false);
	let unexpectedError = $state<string | null>(null);
	const request = $derived(data.staffRequest);
	const quoteError = $derived(form?.quoteError ?? unexpectedError);
	const reviewRequired = $derived(form?.reviewRequired || !!unexpectedError);
	const route = $derived(resolve('/(app)/requests/[inquiryId]', { inquiryId: data.inquiryId }));
	const caps =
		'm-0 font-sans text-[10px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-olive-800 uppercase';
</script>

<svelte:head><title>{request?.inquiry.name ?? 'Request'} · Admin · {site.name}</title></svelte:head>

<div class="mx-auto flex w-full max-w-[760px] flex-col gap-[18px] pb-8">
	<a
		href={resolve('/')}
		class={`self-start rounded-sm text-xs font-semibold no-underline ${focusRing}`}
		>← Back to dashboard</a
	>
	{#if request}
		<header class="flex flex-col gap-3">
			<div class="flex flex-wrap items-center gap-3">
				<h1
					class="m-0 font-sans text-[22px] leading-[1.3] font-bold tracking-(--track-heading) wrap-anywhere text-(--text-body)"
				>
					{request.inquiry.name}
				</h1>
				<Badge tone="inverse" size="sm">{lifecycleLabel(request.inquiry.lifecycle.stage)}</Badge>
			</div>
			<p class="m-0 text-[13px] wrap-anywhere text-(--text-muted)">
				Submitted {submittedDateLabel(request.inquiry.createdAt)} · {request.inquiry.email}
			</p>
			<p class="m-0 text-xs text-(--text-muted)">
				<time datetime={request.inquiry.eventDate}>{eventDateLabel(request.inquiry.eventDate)}</time
				>
				· {eventTypeLabel(request.inquiry.eventType)}
			</p>
			<ol class="m-0 flex list-none gap-1.5 p-0" aria-label="Request lifecycle">
				{#each lifecycleStages as stage (stage)}
					<li
						aria-current={stage === request.inquiry.lifecycle.stage ? 'step' : undefined}
						class="min-w-0 flex-1"
					>
						<div
							aria-hidden="true"
							class={[
								'mb-2 h-1 rounded-full',
								lifecycleStages.indexOf(stage) <=
								lifecycleStages.indexOf(request.inquiry.lifecycle.stage)
									? 'bg-olive-700'
									: 'bg-olive-100'
							]}
						></div>
						<span
							class={[
								'block font-sans text-[8px] font-semibold tracking-[0.05em] uppercase sm:text-[9px]',
								stage === request.inquiry.lifecycle.stage ? 'text-olive-900' : 'text-olive-500'
							]}>{lifecycleLabel(stage)}</span
						>
					</li>
				{/each}
			</ol>
		</header>
		<Card
			variant="flat"
			class="flex flex-col gap-3 border-2 border-olive-700 p-[18px] sm:p-5"
			data-testid="request-summary"
		>
			<p class={caps}>Right now</p>
			<h2
				aria-live="polite"
				aria-atomic="true"
				class="m-0 text-lg leading-[1.3] font-bold text-(--text-body)"
			>
				{requestSummary(request.inquiry.lifecycle.stage)}
			</h2>
			<p class="m-0 text-xs text-(--text-muted)">
				{request.inquiry.lifecycle.stage === 'REQUESTED'
					? 'Review the current Estimate below before issuing a quote.'
					: 'Review the current financial document below.'}
			</p>
			<div class="border-t border-(--border-soft) pt-3">
				<p class={caps}>Current {financialStageLabel(request.financial.stage)}</p>
				<p class="m-0 mt-1 text-[22px] leading-[1.3] font-bold wrap-anywhere">
					{formatMoney(request.financial.total, request.financial.currency)}
				</p>
			</div>
			{#if quoteError}
				<div role="alert" class="flex flex-col items-start gap-3">
					<p class="m-0 text-sm text-rust-600">{quoteError}</p>
					<Button href={route} data-sveltekit-reload variant="secondary" size="sm"
						>Reload to review</Button
					>
				</div>
			{/if}
			{#if canIssueQuote(request, data.user.permissions)}
				<form
					method="POST"
					action="?/issueQuote"
					aria-busy={submitting}
					use:enhance={() => {
						submitting = true;
						return async ({ result, update }) => {
							try {
								if (result.type === 'error') {
									unexpectedError =
										'We couldn’t confirm whether the quote was issued. Reload to review the latest state before trying again.';
								} else {
									await update({ reset: false, invalidateAll: false });
								}
							} finally {
								submitting = false;
							}
						};
					}}
				>
					<input type="hidden" name="expectedVersion" value={request.financial.version} />
					<Button type="submit" disabled={submitting || reviewRequired} class="w-full"
						>{submitting ? 'Issuing quote…' : 'Issue quote'}</Button
					>
				</form>
			{/if}
		</Card>
		<RequestDetails inquiry={request.inquiry} />
		<FinancialDocumentCard financial={request.financial} />
	{:else}
		<h1 class="m-0 text-(--text-heading) [font:var(--type-h2)]">Request unavailable</h1>
		<Card role="alert" class="flex flex-col items-start gap-4">
			<p class="m-0 text-sm text-(--text-muted)">
				{requestErrorMessage(data.requestError ?? 'unavailable')}
			</p>
			{#if data.requestError === 'unavailable'}<Button href={route} data-sveltekit-reload size="sm"
					>Try again</Button
				>{/if}
		</Card>
	{/if}
</div>
