<script lang="ts">
	import { resolve } from '$app/paths';
	import { Badge, Button, Card, focusRing } from '@fionas/ui';
	import { site } from '@fionas/shared';
	import RequestDetails from '$lib/components/requests/request-details.svelte';
	import FinancialDocumentCard from '$lib/components/requests/financial-document-card.svelte';
	import QuoteBuilder from '$lib/components/requests/quote-builder/quote-builder.svelte';
	import PaymentControls from '$lib/components/requests/payment-controls.svelte';
	import PaymentHistory from '$lib/components/requests/payment-history.svelte';
	import FulfillmentControls from '$lib/components/requests/fulfillment-controls.svelte';
	import { receivedTimeLabel } from '$lib/payments.js';
	import { depositTermsLabel, matchesReviewedSuggestion } from '$lib/deposit.js';
	import type { QuoteActionResult } from '$lib/quote-builder.js';
	import {
		eventDateLabel,
		eventTypeLabel,
		formatMoney,
		submittedDateLabel
	} from '$lib/presentation.js';
	import {
		canIssueQuote,
		requestSummaryDescription,
		financialStageLabel,
		lifecycleLabel,
		lifecycleStages,
		requestErrorMessage,
		quoteErrorMessage,
		requestSummary
	} from '$lib/request-workspace.js';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let mutationPending = $state(false);
	let clientReviewRequired = $state(false);
	const request = $derived(data.staffRequest);
	const quoteResult = $derived(
		form && ('quoteValues' in form || 'quoteError' in form) ? (form as QuoteActionResult) : null
	);
	// A native failed POST may render newer reviewed state than the staff member saw: review first.
	const reviewedStateChanged = $derived(
		!!quoteResult?.quoteValues &&
			!!request &&
			(quoteResult.quoteValues.deposit.expectedVersion !== String(request.financial.version) ||
				!matchesReviewedSuggestion(quoteResult.quoteValues.deposit, request.suggestedDepositTerms))
	);
	const reviewRequired = $derived(!!quoteResult?.reviewRequired || reviewedStateChanged);
	const builderResult = $derived(
		reviewedStateChanged && !quoteResult?.reviewRequired
			? { ...quoteResult, quoteError: quoteErrorMessage(409), reviewRequired: true }
			: quoteResult
	);
	const showBuilder = $derived(
		!!request && canIssueQuote(request, data.user.permissions) && (data.quoteOpen || !!quoteResult)
	);
	const mutationReviewRequired = $derived(
		clientReviewRequired ||
			reviewRequired ||
			!!form?.fulfillmentReviewRequired ||
			!!form?.paymentReviewRequired ||
			(!!form?.paymentValues &&
				!!request &&
				(form.paymentValues.expectedVersion !== String(request.financial.version) ||
					(form.paymentValues.expectedProposalId !== undefined &&
						form.paymentValues.expectedProposalId !== request.proposal?.id)))
	);
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
				{requestSummaryDescription(request)}
			</p>
			{#each [['Marked served', request.inquiry.lifecycle.served], ['Closed', request.inquiry.lifecycle.closed]] as [label, milestone] (label)}
				{#if typeof milestone === 'object' && milestone && Number.isFinite(Date.parse(milestone.occurredAt))}
					<p class="m-0 text-xs text-(--text-muted)">
						{label}
						<time datetime={milestone.occurredAt}>{receivedTimeLabel(milestone.occurredAt)}</time>
					</p>
				{/if}
			{/each}
			<div class="border-t border-(--border-soft) pt-3">
				<p class={caps}>Current {financialStageLabel(request.financial.stage)}</p>
				<p class="m-0 mt-1 text-[22px] leading-[1.3] font-bold wrap-anywhere">
					{formatMoney(request.financial.total, request.financial.currency)}
				</p>
				{#if request.financial.stage === 'INVOICE'}<p class="m-0 mt-1 text-sm text-(--text-muted)">
						Balance: {formatMoney(
							request.financial.reconciliation.balance,
							request.financial.currency
						)}
					</p>{/if}
			</div>
			{#if request.depositRequirement.state === 'ACTIVE'}
				<div class="border-t border-(--border-soft) pt-3" data-testid="deposit-summary">
					<p class={caps}>
						{request.inquiry.lifecycle.stage === 'QUOTED'
							? 'Deposit to hold the date'
							: 'Booking deposit'}
					</p>
					<p class="m-0 mt-1 text-lg font-bold">
						{formatMoney(
							request.depositRequirement.requiredAmount.amount,
							request.depositRequirement.requiredAmount.currency
						)}
					</p>
					<p class="m-0 mt-1 text-xs text-(--text-muted)">
						{request.depositRequirement.terms.type === 'PERCENTAGE'
							? depositTermsLabel(request.depositRequirement.terms)
							: 'Fixed deposit'}
					</p>
					{#if request.inquiry.lifecycle.stage === 'QUOTED'}
						<p class="m-0 mt-2 text-sm font-semibold">
							{request.depositRequirement.satisfied
								? 'Deposit requirement met'
								: 'Awaiting deposit'}
						</p>
					{/if}
					{#if request.inquiry.lifecycle.stage !== 'QUOTED'}<p
							class="m-0 mt-2 text-xs text-(--text-muted)"
						>
							Historical accepted deposit. Refunds are shown in payment history.
						</p>{/if}
				</div>
			{/if}
			{#if request && canIssueQuote(request, data.user.permissions)}
				<div class="flex flex-wrap gap-2.5">
					<!-- Once the panel is open, Build quote brings it into view instead of reloading it. -->
					<Button
						href={showBuilder ? '#quote-builder' : `${route}?quote`}
						class="min-h-12 min-w-[150px] flex-1"
						data-testid="build-quote">Build quote</Button
					>
					<!-- Placeholder until declining requests exists: visible as in the design, never actionable. -->
					<Button
						type="button"
						variant="secondary"
						disabled
						title="Declining requests is coming soon"
						class="min-h-12 min-w-[120px] flex-1 border-rust-600 text-rust-600"
						data-testid="decline-request">Decline</Button
					>
				</div>
			{:else if quoteResult?.reviewRequired && !showBuilder}
				<div role="alert" class="flex flex-col items-start gap-3">
					<p class="m-0 text-sm text-rust-600">{quoteResult.quoteError}</p>
					<Button href={route} data-sveltekit-reload variant="secondary" size="sm"
						>Reload to review</Button
					>
				</div>
			{/if}
			<PaymentControls
				{request}
				permissions={data.user.permissions}
				{route}
				error={form?.paymentError}
				reviewRequired={mutationReviewRequired}
				values={form?.paymentValues}
				bind:pending={mutationPending}
				onReviewRequired={() => {
					clientReviewRequired = true;
				}}
			/>
			<FulfillmentControls
				{request}
				permissions={data.user.permissions}
				{route}
				error={form?.fulfillmentError}
				reviewRequired={mutationReviewRequired}
				bind:pending={mutationPending}
				onReviewRequired={() => {
					clientReviewRequired = true;
				}}
			/>
		</Card>
		{#if showBuilder}
			<QuoteBuilder
				{request}
				choices={data.builderChoices}
				result={builderResult ?? data.initialQuote}
				{route}
				blocked={mutationReviewRequired}
				bind:pending={mutationPending}
				onReviewRequired={() => {
					clientReviewRequired = true;
				}}
			/>
		{/if}
		<RequestDetails inquiry={request.inquiry} servicePlan={request.servicePlan ?? null} />
		<FinancialDocumentCard
			financial={request.financial}
			servicePlan={request.servicePlan ?? null}
		/>
		<PaymentHistory {request} />
	{:else}
		<h1 class="m-0 text-(--text-heading) [font:var(--type-h2)]">Request unavailable</h1>
		<Card role="alert" class="flex flex-col items-start gap-4">
			<p class="m-0 text-sm text-(--text-muted)">
				{form?.fulfillmentError ?? requestErrorMessage(data.requestError ?? 'unavailable')}
			</p>
			{#if form?.fulfillmentReviewRequired}
				<Button href={route} data-sveltekit-reload size="sm">Reload to review</Button>
			{:else if data.requestError === 'unavailable'}<Button
					href={route}
					data-sveltekit-reload
					size="sm">Try again</Button
				>{/if}
		</Card>
	{/if}
</div>
