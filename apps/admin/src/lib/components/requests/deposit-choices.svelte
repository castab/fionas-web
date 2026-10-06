<script lang="ts">
	import { onMount } from 'svelte';
	import { focusRing } from '@fionas/ui';
	import {
		depositTermsLabel,
		suggestionValue,
		type DepositChoice,
		type DepositFormValues,
		type DepositErrorField
	} from '$lib/deposit.js';
	import type { DepositTermsRequest } from '$lib/request-contract.js';
	let {
		suggestion,
		currency,
		version,
		values,
		errorField,
		disabled = false
	}: {
		suggestion: DepositTermsRequest;
		currency: string;
		version: number;
		values?: DepositFormValues;
		errorField?: DepositErrorField;
		disabled?: boolean;
	} = $props();
	let enhanced = $state(false);
	let choice = $derived<DepositChoice>(values?.depositChoice ?? 'suggested');
	let percentage = $derived(values?.depositPercentage ?? '');
	let amount = $derived(values?.depositAmount ?? '');
	onMount(() => {
		enhanced = true;
	});
	const inputClass = `mt-2 block w-full rounded-[6px] border border-(--border-soft) bg-(--surface-card) px-3 py-2 text-sm text-(--text-body) ${focusRing}`;
</script>

<input type="hidden" name="expectedVersion" value={values?.expectedVersion ?? version} />
<input
	type="hidden"
	name="reviewedSuggestionType"
	value={values?.reviewedSuggestionType ?? suggestion.type}
/>
<input
	type="hidden"
	name="reviewedSuggestionValue"
	value={values?.reviewedSuggestionValue ?? suggestionValue(suggestion)}
/>
<fieldset
	{disabled}
	class="m-0 mb-4 min-w-0 border-0 border-t border-solid border-(--border-soft) p-0 pt-3"
>
	<legend
		class="px-0 font-sans text-[10px] font-semibold tracking-(--track-caps-tight) text-olive-800 uppercase"
		>Deposit to hold the date</legend
	>
	<div class="mt-2 flex flex-col gap-3">
		<label class="flex items-start gap-2 text-sm">
			<input
				type="radio"
				name="depositChoice"
				value="suggested"
				bind:group={choice}
				class={`mt-1 accent-olive-700 ${focusRing}`}
				aria-describedby={errorField === 'depositChoice' ? 'deposit-error' : undefined}
			/>
			<span
				><span class="block font-semibold">Recommended</span><span
					class="text-xs text-(--text-muted)">{depositTermsLabel(suggestion)}</span
				></span
			>
		</label>
		<div>
			<label class="flex items-center gap-2 text-sm"
				><input
					type="radio"
					name="depositChoice"
					value="percentage"
					bind:group={choice}
					class={`accent-olive-700 ${focusRing}`}
				/>Custom percentage</label
			>
			<div hidden={enhanced && choice !== 'percentage'} class="mt-2 ml-6">
				<label for="deposit-percentage" class="text-xs font-semibold">Deposit percentage</label>
				<input
					id="deposit-percentage"
					name="depositPercentage"
					type="text"
					inputmode="decimal"
					bind:value={percentage}
					disabled={enhanced && choice !== 'percentage'}
					aria-invalid={errorField === 'depositPercentage' ? 'true' : undefined}
					aria-describedby={errorField === 'depositPercentage'
						? 'deposit-percentage-help deposit-error'
						: 'deposit-percentage-help'}
					class={inputClass}
				/>
				<p id="deposit-percentage-help" class="m-0 mt-1 text-xs text-(--text-muted)">
					Greater than 0%, up to 100%.
				</p>
			</div>
		</div>
		<div>
			<label class="flex items-center gap-2 text-sm"
				><input
					type="radio"
					name="depositChoice"
					value="fixed"
					bind:group={choice}
					class={`accent-olive-700 ${focusRing}`}
				/>Fixed amount</label
			>
			<div hidden={enhanced && choice !== 'fixed'} class="mt-2 ml-6">
				<label for="deposit-amount" class="text-xs font-semibold">Deposit amount ({currency})</label
				>
				<input
					id="deposit-amount"
					name="depositAmount"
					type="text"
					inputmode="decimal"
					bind:value={amount}
					disabled={enhanced && choice !== 'fixed'}
					aria-invalid={errorField === 'depositAmount' ? 'true' : undefined}
					aria-describedby={errorField === 'depositAmount' ? 'deposit-error' : undefined}
					class={inputClass}
				/>
			</div>
		</div>
	</div>
</fieldset>
