<script lang="ts">
	import { Button, Card, capsSm, cn, hintText } from '@fionas/ui';
	import { mailtoUrl, site } from '@fionas/shared';
	import type { AmountChoice, PageState } from '$lib/payments/controller.js';
	import { isOnPageCheckoutMode } from '$lib/payments/contract.js';
	import type { PayableTerms } from '$lib/payments/view.js';
	import { STAFF_REVIEW_MESSAGE } from '$lib/payments/copy.js';
	import {
		amountProblemMessage,
		formatCents,
		STRIPE_MAX_CENTS,
		STRIPE_MIN_CENTS,
		validatePartialAmount
	} from '$lib/payments/money.js';
	import { documentLabel } from '$lib/payments/view.js';

	let {
		current,
		onpay,
		onrecover,
		onretry,
		onstartover,
		onrefresh
	}: {
		current: PageState;
		onpay: (choice: AmountChoice) => void;
		onrecover: (choice: AmountChoice) => void;
		onretry: () => void;
		onstartover: () => void;
		onrefresh: () => void;
	} = $props();

	const view = $derived(current.view);
	const summary = $derived(current.summary);
	const busy = $derived(current.busy === 'submitting' || current.busy === 'redirecting');
	const pending = $derived(current.pending);
	const label = $derived(summary ? documentLabel(summary) : null);

	// The terms an amount chooser applies to: the balance due, or the terms a recovery check would
	// use when this tab has no earlier command of its own.
	const invoiceTerms = $derived.by((): (PayableTerms & { purpose: 'INVOICE' }) | null => {
		if (view?.kind === 'balance-due') return view.terms;
		if (view?.kind === 'in-progress' && view.recovery?.purpose === 'INVOICE' && !pending)
			return view.recovery;
		return null;
	});

	let mode = $state<'full' | 'partial'>('full');
	let amountInput = $state('');
	let touched = $state(false);

	// A balance too large for one Stripe payment can only be paid in parts.
	const effectiveMode = $derived(invoiceTerms && !invoiceTerms.fullAllowed ? 'partial' : mode);
	const partial = $derived(
		invoiceTerms && effectiveMode === 'partial'
			? validatePartialAmount(amountInput, invoiceTerms.amountCents)
			: null
	);
	const partialError = $derived(
		partial && !partial.ok && touched && invoiceTerms
			? amountProblemMessage(partial.problem, invoiceTerms.amountCents)
			: null
	);
	const payCents = $derived.by((): bigint | null => {
		if (!invoiceTerms) return null;
		if (effectiveMode === 'full') return invoiceTerms.amountCents;
		return partial?.ok ? partial.cents : null;
	});

	function choice(): AmountChoice | null {
		if (!invoiceTerms) return { partialCents: null };
		if (effectiveMode === 'full') return { partialCents: null };
		touched = true;
		return partial?.ok ? { partialCents: partial.cents } : null;
	}

	function submitPay(event: SubmitEvent) {
		event.preventDefault();
		if (busy || stale) return;
		const selected = choice();
		if (selected) onpay(selected);
	}

	function submitRecover(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		const selected = choice();
		if (selected) onrecover(selected);
	}

	const heading = 'm-0 font-sans text-lg leading-[1.35] font-bold text-(--text-heading)';
	const option =
		'flex min-h-14 cursor-pointer items-center gap-3 rounded-input border px-4 py-3 transition-colors duration-(--dur-fast) ease-out';
	const selected = 'border-olive-700 bg-olive-100/60';
	const unselected = 'border-olive-300/70 bg-cream-100';
	const body = 'm-0 text-(--text-body) [font:var(--type-body-sm)]';
	// This tab's own earlier command can always be resent; anything else is a new decision.
	const ownCommand = $derived(!!pending && !pending.ambiguous && !pending.blocked);
	// When confirmation was dispatched, Elements can check the same attempt without reopening it.
	const completing = $derived(ownCommand && !!pending?.completing);
	const checkOnly = $derived(completing && pending?.uiMode === 'ELEMENTS');
	const canRecover = $derived(
		view?.kind === 'in-progress' && (!completing || checkOnly) && (!!view.recovery || ownCommand)
	);
	// This tab's own form whose terms changed under it: only a same-key check is offered.
	const invalidated = $derived(
		ownCommand && isOnPageCheckoutMode(pending?.uiMode) && !!pending?.termsChanged
	);
	const resumesCheckout = $derived(
		ownCommand && !completing && isOnPageCheckoutMode(pending?.uiMode) && !pending?.termsChanged
	);
	// A summary kept after a failed refresh is display-only: no new payment against it.
	const stale = $derived(!current.summaryFresh);
</script>

{#snippet contact(text: string)}
	<p class={body}>
		{text}
		<!-- eslint-disable svelte/no-navigation-without-resolve -- external mailto link -->
		<a href={mailtoUrl} class="text-olive-800 underline underline-offset-2 hover:text-olive-900"
			>{site.email}</a
		>.
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	</p>
{/snippet}

{#snippet amountChooser(terms: PayableTerms & { purpose: 'INVOICE' })}
	<fieldset class="m-0 flex flex-col gap-2.5 border-0 p-0">
		<legend class={cn(capsSm, 'mb-2 p-0 text-(--text-heading)')}
			>How much would you like to pay?</legend
		>
		<label
			class={cn(
				option,
				effectiveMode === 'full' ? selected : unselected,
				!terms.fullAllowed && 'cursor-not-allowed opacity-60'
			)}
		>
			<input
				type="radio"
				name="amount-choice"
				value="full"
				class="size-5 accent-olive-700"
				checked={effectiveMode === 'full'}
				disabled={!terms.fullAllowed || busy}
				onchange={() => (mode = 'full')}
			/>
			<span class="flex min-w-0 flex-1 flex-col">
				<span class="font-sans text-[15px] font-semibold text-(--text-body)">Remaining balance</span
				>
				{#if !terms.fullAllowed}
					<span class={hintText}
						>Online payments are limited to {formatCents(STRIPE_MAX_CENTS)} each, so please pay in parts.</span
					>
				{/if}
			</span>
			<span class="font-sans text-[15px] font-semibold wrap-anywhere text-(--text-heading)"
				>{formatCents(terms.amountCents)}</span
			>
		</label>
		<label class={cn(option, effectiveMode === 'partial' ? selected : unselected)}>
			<input
				type="radio"
				name="amount-choice"
				value="partial"
				class="size-5 accent-olive-700"
				checked={effectiveMode === 'partial'}
				disabled={busy}
				onchange={() => (mode = 'partial')}
			/>
			<span class="font-sans text-[15px] font-semibold text-(--text-body)">A different amount</span>
		</label>
		{#if effectiveMode === 'partial'}
			<div class="flex flex-col gap-1.5 pl-1">
				<label for="partial-amount" class={cn(capsSm, 'text-(--text-heading)')}>Amount (USD)</label>
				<div class="relative">
					<span
						aria-hidden="true"
						class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 font-sans text-base text-(--text-muted)"
						>$</span
					>
					<input
						id="partial-amount"
						name="amount"
						inputmode="decimal"
						autocomplete="off"
						spellcheck="false"
						placeholder="0.00"
						bind:value={amountInput}
						onblur={() => (touched = amountInput.trim() !== '' || touched)}
						disabled={busy}
						aria-invalid={partialError ? 'true' : undefined}
						aria-describedby="partial-amount-hint{partialError ? ' partial-amount-error' : ''}"
						class="w-full rounded-input border border-olive-300/70 bg-cream-100 py-2.5 pr-3.5 pl-8 font-sans text-base leading-6 text-(--text-body) transition-[border-color,box-shadow] duration-(--dur-fast) ease-(--ease-out) hover:border-olive-500 focus-visible:border-olive-700 focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring) focus-visible:outline-solid disabled:opacity-45 aria-invalid:border-rust-600"
					/>
				</div>
				<p id="partial-amount-hint" class={cn(hintText, 'm-0')}>
					Between {formatCents(STRIPE_MIN_CENTS)} and {formatCents(
						terms.amountCents < STRIPE_MAX_CENTS ? terms.amountCents : STRIPE_MAX_CENTS
					)}.
				</p>
				{#if partialError}
					<p
						id="partial-amount-error"
						role="alert"
						class="m-0 font-sans text-[13px] leading-snug text-rust-600"
					>
						{partialError}
					</p>
				{/if}
			</div>
		{/if}
	</fieldset>
{/snippet}

{#snippet staleGate()}
	{#if stale}
		<div
			class="flex flex-col items-start gap-2 rounded-input border border-olive-300 bg-cream-200 px-4 py-3"
			data-testid="stale-summary"
		>
			<p class="m-0 text-(--text-body) [font:var(--type-body-sm)]">
				We couldn't confirm your current balance, so paying is paused until it loads again.
			</p>
			<Button
				variant="secondary"
				size="sm"
				class="min-h-11"
				disabled={current.busy !== null}
				onclick={onrefresh}>Check again</Button
			>
		</div>
	{/if}
{/snippet}

{#snippet submitLabel(text: string)}
	{current.busy === 'redirecting'
		? 'Taking you to secure checkout…'
		: current.busy === 'submitting'
			? 'Starting secure checkout…'
			: text}
{/snippet}

<Card class="flex flex-col gap-4 px-[26px] py-6 max-[600px]:px-5" data-testid="payment-action">
	{#if pending?.blocked}
		<h2 class={heading}>Let's start this payment again</h2>
		<p class={body}>
			This payment request couldn't be used. Start over to review your current balance, then pay if
			anything is still due.
		</p>
		<Button size="lg" class="min-h-13 w-full" disabled={busy} onclick={onstartover}
			>Start over</Button
		>
	{:else if pending?.ambiguous && !busy}
		<h2 class={heading}>Finish starting your payment</h2>
		<p class={body}>
			We didn't hear back after you started a payment of {formatCents(pending.amountCents)}. Trying
			again safely continues that same payment.
		</p>
		<Button size="lg" class="min-h-13 w-full" onclick={onretry} data-testid="retry-payment"
			>Try again</Button
		>
	{:else if view?.kind === 'deposit-due'}
		<div class="flex flex-col gap-1">
			<h2 class={heading}>Pay your deposit</h2>
			<p class={body}>
				Paying the required deposit confirms your booking once the payment goes through.
			</p>
		</div>
		<div class="flex items-baseline justify-between gap-3 rounded-input bg-cream-200 px-4 py-3.5">
			<span class={cn(capsSm, 'text-(--text-muted)')}>Deposit due</span>
			<span
				class="font-sans text-[22px] leading-[1.25] font-bold wrap-anywhere text-(--text-heading)"
				data-testid="deposit-amount">{formatCents(view.terms.amountCents)}</span
			>
		</div>
		{@render staleGate()}
		<form onsubmit={submitPay} class="flex flex-col gap-2.5" aria-busy={busy}>
			<Button
				type="submit"
				size="lg"
				class="min-h-13 w-full"
				disabled={busy || stale || !!pending || current.busy === 'refreshing'}
				data-testid="pay"
				>{@render submitLabel(`Pay deposit ${formatCents(view.terms.amountCents)}`)}</Button
			>
			<p class={cn(hintText, 'm-0 text-center')}>
				You'll enter your card details securely with Stripe.
			</p>
		</form>
	{:else if view?.kind === 'balance-due'}
		<div class="flex flex-col gap-1">
			<h2 class={heading}>Make a payment</h2>
			<p class={body}>
				Your payment is credited toward the outstanding balance{label ? ` on your ${label}` : ''}.
			</p>
		</div>
		{@render staleGate()}
		<form onsubmit={submitPay} class="flex flex-col gap-4" aria-busy={busy} novalidate>
			{@render amountChooser(view.terms)}
			<Button
				type="submit"
				size="lg"
				class="min-h-13 w-full"
				disabled={busy || stale || !!pending || current.busy === 'refreshing'}
				data-testid="pay"
				>{@render submitLabel(payCents !== null ? `Pay ${formatCents(payCents)}` : 'Pay')}</Button
			>
			<p class={cn(hintText, 'm-0 text-center')}>
				You'll enter your card details securely with Stripe.
			</p>
		</form>
	{:else if view?.kind === 'in-progress'}
		<div class="flex flex-col gap-1">
			{#if completing}
				<h2 class={heading}>We're confirming your payment</h2>
				<p class={body}>
					We're waiting for our payment processor to confirm it, so there's no need to pay again.
					This page checks for updates while it's open.
				</p>
			{:else}
				<h2 class={heading}>A payment is already underway</h2>
				<p class={body}>
					Another payment for this booking may already be in progress, so a new one can't start
					right now. This page checks for updates while it's open.
				</p>
			{/if}
		</div>
		{#if canRecover}
			{#if !ownCommand}{@render staleGate()}{/if}
			<form onsubmit={submitRecover} class="flex flex-col gap-4" aria-busy={busy} novalidate>
				{#if invalidated}
					<p class={body} data-testid="invalidated-payment">
						Your booking changed after you opened a payment form for {formatCents(
							pending!.amountCents
						)}. We'll check that earlier payment with our payment processor first. You can review
						your balance and pay again once it's resolved.
					</p>
				{:else if resumesCheckout}
					<p class={body}>
						Your secure payment form for {formatCents(pending!.amountCents)} is still open. Continue to
						return to that same payment here.
					</p>
				{:else if checkOnly}
					<p class={body}>You can check the status of this same payment below.</p>
				{:else if invoiceTerms}
					<p class={body}>
						We'll check that earlier payment first. If it's still open you can go back to it; if it
						expired, we'll start a new checkout for the amount you choose.
					</p>
					{@render amountChooser(invoiceTerms)}
				{:else}
					<p class={body}>
						We'll check that earlier payment first. If it's still open you can go back to it; if it
						expired, you can continue with a new checkout.
					</p>
				{/if}
				<Button
					type="submit"
					variant="secondary"
					size="lg"
					class="min-h-13 w-full whitespace-normal"
					disabled={busy || (stale && !ownCommand)}
					data-testid="recover-payment"
					>{@render submitLabel(
						invalidated || checkOnly
							? 'Check previous payment'
							: resumesCheckout
								? 'Continue your payment'
								: 'Check previous payment and continue'
					)}</Button
				>
			</form>
		{/if}
		<p class={cn(hintText, 'm-0')} role="status" data-testid="polling-status">
			{current.polling === 'active'
				? 'Checking for updates…'
				: current.polling === 'exhausted'
					? 'Still waiting? Check again in a moment.'
					: ''}
		</p>
		{#if current.polling !== 'active'}
			<Button
				variant="ghost"
				size="sm"
				class="min-h-11 self-start"
				disabled={current.busy !== null}
				onclick={onrefresh}>Check again</Button
			>
		{/if}
	{:else if view?.kind === 'reconciliation'}
		<h2 class={heading}>A payment needs staff review</h2>
		<p class={body} data-testid="reconciliation-message">{STAFF_REVIEW_MESSAGE}</p>
		{@render contact('Reach us at')}
	{:else if view?.kind === 'no-balance'}
		<h2 class={heading}>{view.creditCents ? 'You have a credit' : "You're all paid up"}</h2>
		<p class={body}>
			{view.creditCents
				? `Your account shows a credit of ${formatCents(view.creditCents)}. We'll be in touch about it.`
				: 'There is no balance due right now. Thank you!'}
		</p>
	{:else if view?.kind === 'closed'}
		<h2 class={heading}>This booking is closed</h2>
		<p class={body}>
			Thanks for celebrating with {site.name}! Your payment history is below for your records.
		</p>
	{:else if view?.kind === 'staff-assist'}
		<h2 class={heading}>
			{view.reason === 'below-minimum'
				? 'This balance is too small to pay online'
				: 'This amount is too large to pay online'}
		</h2>
		<p class={body}>
			{view.reason === 'below-minimum'
				? `Online payments must be at least ${formatCents(STRIPE_MIN_CENTS)}. We'll settle the rest with you directly.`
				: `Online payments are limited to ${formatCents(STRIPE_MAX_CENTS)} each. We'll help you pay another way.`}
		</p>
		{@render contact('Please contact us at')}
	{:else if view?.kind === 'not-ready'}
		<h2 class={heading}>Your quote isn't ready yet</h2>
		<p class={body}>We'll let you know as soon as it's ready to review and pay.</p>
	{:else}
		<h2 class={heading}>Online payment isn't available for this booking</h2>
		{@render contact("We'll help you pay another way. Reach us at")}
	{/if}
</Card>
