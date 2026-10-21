<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { Button, Card, focusRing } from '@fionas/ui';
	import type { CurrentStaffRequest } from '$lib/request-contract.js';
	import {
		canRecordDeposit,
		canRecordInvoicePayment,
		invoiceAmountValid,
		manualPaymentMethods,
		paymentErrorMessage,
		paymentMethodLabel,
		type PaymentFormValues
	} from '$lib/payments.js';
	import { eventDateLabel, formatMoney } from '$lib/presentation.js';

	let {
		request,
		permissions,
		route,
		error,
		reviewRequired = false,
		values,
		pending = $bindable(false),
		onReviewRequired
	}: {
		request: CurrentStaffRequest;
		permissions: string[];
		route: string;
		error?: string;
		reviewRequired?: boolean;
		values?: PaymentFormValues;
		pending?: boolean;
		onReviewRequired: () => void;
	} = $props();
	let submitting = $state(false);
	let unexpectedError = $state<string | null>(null);
	let amount = $derived(values?.amount ?? '');
	let method = $derived<string>(values?.method ?? 'CASH');
	const deposit = $derived(canRecordDeposit(request, permissions));
	const invoice = $derived(canRecordInvoicePayment(request, permissions));
	const changed = $derived(
		!!values &&
			(values.expectedVersion !== String(request.financial.version) ||
				(values.expectedProposalId !== undefined &&
					values.expectedProposalId !== request.proposal?.id))
	);
	const blocked = $derived(reviewRequired || !!unexpectedError || changed);
	const message = $derived(unexpectedError ?? (changed ? paymentErrorMessage(409) : error));
	const currency = $derived(request.financial.currency);
	const balance = $derived(request.financial.reconciliation.balance);
	const depositAmount = $derived(
		request.depositRequirement.state === 'ACTIVE'
			? formatMoney(request.depositRequirement.requiredAmount.amount, currency)
			: null
	);
	// The label echoes a valid entry, exactly as typed; it never sums or rounds.
	const amountLabel = $derived(
		invoiceAmountValid(amount, balance, currency) ? formatMoney(amount, currency) : null
	);
	const submit: SubmitFunction = ({ cancel }) => {
		if (pending || blocked) {
			cancel();
			return;
		}
		submitting = true;
		pending = true;
		return async ({ result, update }) => {
			try {
				if (result.type === 'error') {
					unexpectedError = paymentErrorMessage(503, true);
					onReviewRequired();
				} else {
					if (result.type === 'redirect') amount = '';
					await update({ reset: false, invalidateAll: false });
					if (result.type === 'failure') document.getElementById('payment-error')?.focus();
				}
			} finally {
				submitting = false;
				pending = false;
			}
		};
	};
	const caps =
		'm-0 font-sans text-[11px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-heading) uppercase';
	const inputClass = `w-full min-w-0 rounded-input border border-(--border-soft) bg-(--surface-card) px-3 py-2.5 text-sm ${focusRing}`;
</script>

<Card
	variant="flat"
	id="record-payment"
	role="region"
	aria-labelledby="record-payment-title"
	class={[
		'flex flex-col gap-4 border-2 p-[18px] sm:p-5',
		deposit ? 'border-moss-600' : 'border-olive-700'
	]}
>
	<div class="flex flex-col gap-1">
		<h2 id="record-payment-title" class={caps}>
			{deposit ? 'Record deposit' : 'Record payment'}
		</h2>
		{#if deposit}
			<p class="m-0 text-xs leading-[1.55] text-(--text-muted)">
				Must be recorded in full to book this event. Recording it books {eventDateLabel(
					request.inquiry.eventDate
				)} and turns Quote v{request.financial.version} into an Invoice.
			</p>
		{:else if invoice}
			<p class="m-0 text-xs leading-[1.55] text-(--text-muted)">
				Partial payments are fine — any amount up to the {formatMoney(balance, currency)} balance on Invoice
				v{request.financial.version}, in whole cents.
			</p>
		{/if}
	</div>
	{#if message}
		<div role="alert" class="flex flex-col items-start gap-3">
			<p id="payment-error" tabindex="-1" class="m-0 text-sm text-rust-600">{message}</p>
			{#if blocked}<Button href={route} data-sveltekit-reload variant="secondary" size="sm"
					>Reload to review</Button
				>{/if}
		</div>
	{/if}
	{#if deposit || invoice}
		<form
			method="POST"
			action={deposit ? '?/recordDeposit' : '?/recordInvoicePayment'}
			use:enhance={submit}
			aria-busy={submitting}
			class="flex flex-col gap-4"
			data-testid="payment-form"
		>
			<input
				type="hidden"
				name="expectedVersion"
				value={values?.expectedVersion ?? request.financial.version}
			/>
			{#if deposit}
				<input
					type="hidden"
					name="expectedProposalId"
					value={values?.expectedProposalId ?? request.proposal?.id}
				/>
				<div class="flex flex-col gap-1.5">
					<p class={caps}>Deposit amount</p>
					<p
						class="m-0 flex flex-wrap items-baseline gap-2 self-start rounded-input bg-cream-200 px-3.5 py-2.5"
					>
						<span class="text-xl font-bold wrap-anywhere text-(--text-heading)"
							>{depositAmount}</span
						>
						<span class="text-[11.5px] text-(--text-muted)">Set by the approved quote</span>
					</p>
				</div>
				<p class="m-0 text-xs text-(--text-muted)">
					If more than the deposit was received, record the deposit first. Additional money can be
					recorded after the event becomes booked.
				</p>
			{:else}
				<div class="flex max-w-[240px] flex-col gap-1.5">
					<label for="payment-amount" class={caps}>Payment amount ({currency})</label>
					<input
						id="payment-amount"
						name="amount"
						type="text"
						inputmode="decimal"
						required
						pattern="[0-9]+(\.[0-9]+)?"
						maxlength="100"
						bind:value={amount}
						disabled={pending || blocked}
						class={inputClass}
						aria-invalid={error && !blocked ? 'true' : undefined}
						aria-describedby={message ? 'payment-error' : 'payment-amount-help'}
						oninput={(event) => {
							event.currentTarget.setCustomValidity(
								invoiceAmountValid(event.currentTarget.value, balance, currency)
									? ''
									: 'Enter a positive amount up to the Invoice balance, using the currency’s normal decimal precision.'
							);
						}}
					/>
					<p id="payment-amount-help" class="m-0 text-xs text-(--text-muted)">
						Up to {formatMoney(balance, currency)}
					</p>
				</div>
			{/if}
			<fieldset disabled={pending || blocked} class="m-0 min-w-0 border-0 p-0">
				<legend class={`mb-2.5 ${caps}`}>Payment method</legend>
				<div class="flex flex-wrap gap-x-5 gap-y-2">
					{#each manualPaymentMethods as option (option)}
						<label class="flex min-h-11 items-center gap-2 text-sm font-semibold">
							<input
								type="radio"
								name="method"
								value={option}
								bind:group={method}
								class={`size-4 accent-olive-700 ${focusRing}`}
							/>
							{paymentMethodLabel(option)}
						</label>
					{/each}
				</div>
			</fieldset>
			<div class="flex flex-wrap gap-2.5">
				<Button
					type="submit"
					class={[
						'min-h-12 flex-[1.4_1_150px]',
						deposit && 'bg-moss-600 text-cream-100 not-disabled:hover:bg-moss-600/90'
					]}
					disabled={pending || blocked}
					>{submitting
						? 'Recording payment…'
						: deposit && depositAmount
							? `Record ${depositAmount} deposit`
							: amountLabel
								? `Record ${amountLabel} payment`
								: 'Record payment'}</Button
				>
				<!-- Unavailable mid-submit; once blocked, Reload to review is the only way out, so the
				     alert explaining the block can never be dismissed by closing the panel. -->
				{#if !blocked}<Button
						href={route}
						variant="secondary"
						disabled={pending}
						class="min-h-12 flex-[1_1_120px]">Cancel</Button
					>{/if}
			</div>
		</form>
	{/if}
</Card>
