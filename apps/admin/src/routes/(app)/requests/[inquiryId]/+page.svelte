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
	import { canRecordDeposit, canRecordInvoicePayment, receivedTimeLabel } from '$lib/payments.js';
	import { isDecimal } from '$lib/payment-history.js';
	import { depositTermsLabel, matchesReviewedSuggestion } from '$lib/deposit.js';
	import type { QuoteActionResult } from '$lib/quote-builder.js';
	import { formatMoney, submittedDateLabel } from '$lib/presentation.js';
	import {
		canCloseInquiry,
		canIssueQuote,
		canMarkServed,
		requestSummaryDescription,
		lifecycleLabel,
		lifecycleStages,
		lifecycleTone,
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
	const canPay = $derived(
		!!request &&
			(canRecordDeposit(request, data.user.permissions) ||
				canRecordInvoicePayment(request, data.user.permissions))
	);
	// Opened by ?payment (works without JavaScript); a returned payment result keeps it open.
	const showPayment = $derived(
		!!request &&
			(form?.paymentError !== undefined || !!form?.paymentValues || (data.paymentOpen && canPay))
	);
	const stageIndex = $derived(
		request ? lifecycleStages.indexOf(request.inquiry.lifecycle.stage) : -1
	);
	const milestone = $derived.by(() => {
		const lifecycle = request?.inquiry.lifecycle;
		const [label, value] =
			lifecycle?.stage === 'CLOSED'
				? ['Closed', lifecycle.closed]
				: lifecycle?.stage === 'SERVED'
					? ['Marked served', lifecycle.served]
					: [null, undefined];
		return label && value && Number.isFinite(Date.parse(value.occurredAt))
			? { label, at: value.occurredAt }
			: null;
	});
	const caps =
		'm-0 font-sans text-[11px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-heading) uppercase';
	const micro =
		'm-0 font-sans text-[9.5px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-muted) uppercase';
</script>

<svelte:head><title>{request?.inquiry.name ?? 'Request'} · Admin · {site.name}</title></svelte:head>

<div class="mx-auto flex w-full max-w-[760px] flex-col gap-[18px] pb-8">
	<a
		href={resolve('/')}
		class={`inline-flex min-h-11 items-center self-start rounded-sm font-sans text-[11px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-olive-800 uppercase no-underline hover:text-olive-900 ${focusRing}`}
		>← Back to dashboard</a
	>
	{#if request}
		{@const stage = request.inquiry.lifecycle.stage}
		{@const financial = request.financial}
		{@const deposit = request.depositRequirement}
		<header class="flex flex-col gap-2">
			<div class="flex flex-wrap items-center gap-3">
				<h1
					class="m-0 font-sans text-[22px] leading-[1.3] font-bold tracking-(--track-heading) wrap-anywhere text-(--text-body)"
				>
					{request.inquiry.name}
				</h1>
				<Badge tone={lifecycleTone(stage)} size="sm">{lifecycleLabel(stage)}</Badge>
			</div>
			<p class="m-0 text-[13px] wrap-anywhere text-(--text-muted)">
				Submitted {submittedDateLabel(request.inquiry.createdAt)} · {request.inquiry.email}
			</p>
		</header>
		<ol class="m-0 flex list-none gap-1 p-0 sm:gap-1.5" aria-label="Request lifecycle">
			{#each lifecycleStages as step, i (step)}
				<li aria-current={i === stageIndex ? 'step' : undefined} class="min-w-0 flex-1">
					<div
						aria-hidden="true"
						class={[
							'mb-1.5 h-1 rounded-full',
							i < stageIndex
								? 'bg-olive-300'
								: i === stageIndex
									? 'bg-olive-700'
									: 'bg-(--border-soft)'
						]}
					></div>
					<span
						class={[
							'block font-sans text-[8.5px] leading-[1.4] tracking-[0.05em] uppercase sm:text-[9.5px] sm:tracking-[0.1em]',
							i === stageIndex
								? 'font-bold text-(--text-heading)'
								: i < stageIndex
									? 'font-semibold text-(--text-muted)'
									: 'font-medium text-(--text-muted)'
						]}>{lifecycleLabel(step)}</span
					>
				</li>
			{/each}
		</ol>
		<Card
			variant="flat"
			class={[
				'flex flex-col gap-3.5 border-2 p-[18px] sm:p-5',
				stage === 'REQUESTED' || stage === 'QUOTED' ? 'border-olive-700' : 'border-moss-600'
			]}
			data-testid="request-summary"
		>
			<div class="flex flex-col gap-1.5">
				<p class={caps}>Right now</p>
				<h2
					aria-live="polite"
					aria-atomic="true"
					class="m-0 text-lg leading-[1.35] font-bold text-(--text-body)"
				>
					{requestSummary(request, data.today)}
				</h2>
				<p class="m-0 text-[12.5px] leading-[1.6] text-(--text-muted)">
					{#if milestone}{milestone.label}
						<time datetime={milestone.at}>{receivedTimeLabel(milestone.at)}</time>.{/if}
					{requestSummaryDescription(request, data.today)}
				</p>
			</div>
			<div class="flex flex-wrap gap-3 border-t border-(--border-soft) pt-3">
				{#if financial.stage === 'INVOICE'}
					<div class="flex min-w-0 flex-1 flex-col gap-0.5">
						<span class={micro}>Total</span>
						<span class="text-[17px] leading-[1.25] font-bold wrap-anywhere text-(--text-heading)"
							>{formatMoney(financial.total, financial.currency)}</span
						>
					</div>
					{#if isDecimal(financial.reconciliation.netApplied)}
						<div class="flex min-w-0 flex-1 flex-col gap-0.5">
							<span class={micro}>Paid</span>
							<span class="text-[17px] leading-[1.25] font-bold wrap-anywhere text-moss-600"
								>{formatMoney(financial.reconciliation.netApplied, financial.currency)}</span
							>
						</div>
					{/if}
					<div class="flex min-w-0 flex-1 flex-col gap-0.5" data-testid="request-balance">
						<span class={micro}>Balance</span>
						<span class="text-[22px] leading-[1.25] font-bold wrap-anywhere text-(--text-heading)"
							>{formatMoney(financial.reconciliation.balance, financial.currency)}</span
						>
					</div>
				{:else}
					<div class="flex min-w-0 flex-1 flex-col gap-0.5">
						<span class={micro}
							>{financial.stage === 'ESTIMATE' ? 'Estimate total' : 'Quote total'}</span
						>
						<span class="text-[22px] leading-[1.25] font-bold wrap-anywhere text-(--text-heading)"
							>{formatMoney(financial.total, financial.currency)}</span
						>
					</div>
					{#if deposit.state === 'ACTIVE' && stage === 'QUOTED'}
						<div class="flex min-w-0 flex-1 flex-col gap-0.5" data-testid="deposit-summary">
							<span class={micro}>Deposit to hold the date</span>
							<span class="text-[22px] leading-[1.25] font-bold wrap-anywhere text-(--text-heading)"
								>{formatMoney(deposit.requiredAmount.amount, deposit.requiredAmount.currency)}</span
							>
							<span class="text-[11.5px] text-(--text-muted)"
								>{deposit.terms.type === 'PERCENTAGE'
									? depositTermsLabel(deposit.terms)
									: 'Fixed deposit'} · {deposit.satisfied
									? 'deposit requirement met'
									: 'awaiting deposit'}</span
							>
						</div>
					{/if}
				{/if}
			</div>
			{#if canIssueQuote(request, data.user.permissions)}
				<div class="flex flex-wrap gap-2.5">
					<!-- Once the panel is open, Build quote brings it into view instead of reloading it. -->
					<Button
						href={showBuilder ? '#quote-builder' : `${route}?quote`}
						class="min-h-12 flex-[1.4_1_150px]"
						data-testid="build-quote">Build quote</Button
					>
					<!-- Placeholder until declining requests exists: visible as in the design, never actionable. -->
					<Button
						type="button"
						variant="secondary"
						disabled
						title="Declining requests is coming soon"
						class="min-h-12 flex-[1_1_120px] border-rust-600 text-rust-600"
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
			{#if canPay || !!form?.fulfillmentError || canMarkServed(request, data.user.permissions) || canCloseInquiry(request, data.user.permissions)}<div
					class="flex flex-wrap gap-2.5"
				>
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
					{#if canPay}
						<!-- Once the panel is open, this brings it into view instead of reloading it. -->
						<Button
							href={showPayment ? '#record-payment' : `${route}?payment`}
							variant={canMarkServed(request, data.user.permissions) ? 'secondary' : 'primary'}
							disabled={mutationPending || mutationReviewRequired}
							class="min-h-12 flex-[1_1_140px] aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
							data-testid="open-payment"
							>{canRecordDeposit(request, data.user.permissions)
								? 'Record deposit'
								: 'Record payment'}</Button
						>
					{/if}
				</div>{/if}
		</Card>
		{#if showPayment}
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
		{/if}
		{#if showBuilder}
			<QuoteBuilder
				{request}
				result={builderResult ?? data.initialQuote}
				blocked={mutationReviewRequired}
				bind:pending={mutationPending}
				onReviewRequired={() => {
					clientReviewRequired = true;
				}}
			/>
		{/if}
		<RequestDetails
			inquiry={request.inquiry}
			showPicks={stage === 'REQUESTED' || !request.servicePlan}
		/>
		<FinancialDocumentCard
			{financial}
			{stage}
			proposal={request.proposal ?? null}
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
