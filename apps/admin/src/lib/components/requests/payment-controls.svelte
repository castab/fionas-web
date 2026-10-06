<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { Button, focusRing } from '@fionas/ui';
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
	import { formatMoney } from '$lib/presentation.js';

	let {
		request,
		permissions,
		route,
		error,
		reviewRequired = false,
		values
	}: {
		request: CurrentStaffRequest;
		permissions: string[];
		route: string;
		error?: string;
		reviewRequired?: boolean;
		values?: PaymentFormValues;
	} = $props();
	let submitting = $state(false);
	let unexpectedError = $state<string | null>(null);
	let amount = $derived(values?.amount ?? '');
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
	const submit: SubmitFunction = () => {
		submitting = true;
		return async ({ result, update }) => {
			try {
				if (result.type === 'error') unexpectedError = paymentErrorMessage(503, true);
				else {
					if (result.type === 'redirect') amount = '';
					await update({ reset: false, invalidateAll: false });
					if (result.type === 'failure') document.getElementById('payment-error')?.focus();
				}
			} finally {
				submitting = false;
			}
		};
	};
	const inputClass = `w-full min-w-0 rounded-md border border-(--border-soft) bg-(--surface-card) px-3 py-2 text-sm ${focusRing}`;
</script>

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
		class="flex flex-col gap-3 border-t border-(--border-soft) pt-3"
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
			<p class="m-0 text-sm font-semibold">Must be recorded in full to book this event.</p>
			<p class="m-0 text-xs text-(--text-muted)">
				If more than the deposit was received, record the deposit first. Additional money can be
				recorded after the event becomes booked.
			</p>
		{:else}
			<p class="m-0 text-sm font-semibold">
				Invoice balance: {formatMoney(
					request.financial.reconciliation.balance,
					request.financial.currency
				)}
			</p>
			<label for="payment-amount" class="text-xs font-semibold"
				>Payment amount ({request.financial.currency})</label
			>
			<input
				id="payment-amount"
				name="amount"
				type="text"
				inputmode="decimal"
				required
				pattern="[0-9]+(\.[0-9]+)?"
				maxlength="100"
				bind:value={amount}
				disabled={submitting || blocked}
				class={inputClass}
				aria-invalid={error && !blocked ? 'true' : undefined}
				aria-describedby={message ? 'payment-error' : 'payment-amount-help'}
				oninput={(event) => {
					event.currentTarget.setCustomValidity(
						invoiceAmountValid(
							event.currentTarget.value,
							request.financial.reconciliation.balance,
							request.financial.currency
						)
							? ''
							: 'Enter a positive amount up to the Invoice balance, using the currency’s normal decimal precision.'
					);
				}}
			/>
			<p id="payment-amount-help" class="m-0 text-xs text-(--text-muted)">
				Enter a positive amount up to the balance. Partial payments are accepted.
			</p>
		{/if}
		<label for="payment-method" class="text-xs font-semibold">Payment method</label>
		<select
			id="payment-method"
			name="method"
			disabled={submitting || blocked}
			class={inputClass}
			value={values?.method ?? 'CASH'}
		>
			{#each manualPaymentMethods as method (method)}<option value={method}
					>{paymentMethodLabel(method)}</option
				>{/each}
		</select>
		<Button type="submit" class="w-full" disabled={submitting || blocked}
			>{submitting
				? 'Recording payment…'
				: deposit && request.depositRequirement.state === 'ACTIVE'
					? `Record ${formatMoney(request.depositRequirement.requiredAmount.amount, request.financial.currency)} deposit`
					: 'Record payment'}</Button
		>
	</form>
{/if}
