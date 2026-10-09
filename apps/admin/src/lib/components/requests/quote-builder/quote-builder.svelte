<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { onMount, untrack } from 'svelte';
	import { Button, Card, focusRing } from '@fionas/ui';
	import DepositChoices from '$lib/components/requests/deposit-choices.svelte';
	import type { CurrentStaffRequest } from '$lib/request-contract.js';
	import {
		initialQuoteValues,
		type QuoteActionResult,
		type LineDraft
	} from '$lib/quote-builder.js';
	import { formatMoney } from '$lib/presentation.js';
	let {
		request,
		result,
		blocked = false,
		pending = $bindable(false),
		onReviewRequired
	}: {
		request: CurrentStaffRequest;
		result: QuoteActionResult | null;
		blocked?: boolean;
		pending?: boolean;
		onReviewRequired: () => void;
	} = $props();
	const seed = untrack(() => result);
	let values = $state(untrack(() => seed?.quoteValues ?? initialQuoteValues(request)));
	let preview = $state(seed?.preview ?? null);
	let error = $state(seed?.quoteError ?? '');
	let fieldErrors = $state(seed?.fieldErrors ?? {});
	let reviewRequired = $state(seed?.reviewRequired ?? false);
	let reviewStale = $state(seed?.notices?.reviewStale ?? false);
	let dirty = $state(false);
	let hydrated = $state(false);
	let formElement = $state<HTMLFormElement>();
	let previewButton = $state<HTMLButtonElement>();
	let timer: ReturnType<typeof setTimeout>;
	let sequence = 0;
	let previewController: AbortController | undefined;
	onMount(() => {
		hydrated = true;
		return () => {
			clearTimeout(timer);
			previewController?.abort();
		};
	});
	const input = `mt-1 w-full rounded-[6px] border border-(--border-soft) bg-(--surface-card) px-3 py-2 text-sm ${focusRing}`;
	const blank = (): LineDraft => ({
		key: crypto.randomUUID(),
		description: '',
		unitPrice: '',
		taxAmount: '0.00',
		currency: request.financial.currency,
		note: ''
	});
	const rows = $derived([
		...values.lines,
		{
			key: 'blank-row',
			description: '',
			unitPrice: '',
			taxAmount: '0.00',
			currency: request.financial.currency,
			note: ''
		}
	]);
	function changed() {
		dirty = true;
		error = '';
		clearTimeout(timer);
		if (hydrated && !pending && !reviewRequired)
			timer = setTimeout(() => formElement?.requestSubmit(previewButton), 300);
	}
	function move(i: number, d: number) {
		if (i + d < 0 || i + d >= values.lines.length) return;
		[values.lines[i], values.lines[i + d]] = [values.lines[i + d], values.lines[i]];
		changed();
	}
	function remove(i: number) {
		values.lines.splice(i, 1);
		changed();
	}
	function add(kind = 'service') {
		const row = blank();
		if (kind !== 'service')
			row.description =
				kind === 'charge' ? 'Additional charge' : kind === 'discount' ? 'Discount' : 'Credit';
		values.lines.push(row);
		dirty = true;
		clearTimeout(timer);
	}
</script>

<Card data-testid="quote-builder" id="quote-builder" class="flex flex-col gap-5 p-5">
	<div>
		<h2 class="m-0 [font:var(--type-h3)]">Issue quote</h2>
		<p class="mt-1 text-xs text-(--text-muted)">
			Review final lines and the service you’ll provide. Totals and deposit come from Commerce.
		</p>
	</div>
	{#if error}<p role="alert" class="text-sm text-(--text-body)">{error}</p>{/if}
	{#if Object.keys(fieldErrors).length}<p role="alert" class="text-sm">
			{Object.values(fieldErrors).join(' ')}
		</p>{/if}
	{#if reviewStale}<p role="status" class="text-sm">
			The quote changed since you reviewed it. Review this preview, then click Issue quote again.
		</p>{/if}
	{#if reviewRequired}<p role="alert">Reload this request to review the latest state.</p>
		<a
			href={resolve('/(app)/requests/[inquiryId]', { inquiryId: request.inquiry.id })}
			data-sveltekit-reload>Reload to review</a
		>{/if}
	<form
		method="POST"
		action="?quote&/previewQuote"
		bind:this={formElement}
		oninput={changed}
		onchange={changed}
		use:enhance={({ submitter, controller }) => {
			const issuing = submitter?.getAttribute('formaction')?.includes('issueQuote') ?? false;
			if (!issuing) {
				previewController?.abort();
				previewController = controller;
			}
			const current = ++sequence;
			pending = true;
			return async ({ result, update }) => {
				if (current !== sequence) return;
				pending = false;
				if (result.type === 'redirect') {
					await update();
					return;
				}
				if (result.type === 'error') {
					error = 'We couldn’t confirm the response. Reload before issuing.';
					reviewRequired = issuing;
					if (issuing) onReviewRequired();
					return;
				}
				const data = result.data as QuoteActionResult;
				if (data.quoteValues) values = data.quoteValues;
				preview = data.preview ?? null;
				error = data.quoteError ?? '';
				fieldErrors = data.fieldErrors ?? {};
				reviewRequired = data.reviewRequired ?? false;
				reviewStale = data.notices?.reviewStale ?? false;
				dirty = !data.preview;
				if (reviewRequired) onReviewRequired();
			};
		}}
	>
		<input type="hidden" name="reviewedCurrency" value={values.reviewedCurrency} />
		<input type="hidden" name="reviewToken" value={values.reviewToken} />
		<input type="hidden" name="reviewedFingerprint" value={values.reviewedFingerprint} />
		<fieldset disabled={blocked || reviewRequired || pending} class="m-0 min-w-0 border-0 p-0">
			<legend class="text-xs font-semibold text-olive-800 uppercase">Final quote lines</legend>
			<div class="mt-3 flex flex-col gap-4">
				{#each rows as row, i (row.lineItemId ?? row.key)}
					<div
						class="rounded-[10px] border border-(--border-soft) p-3"
						data-testid="quote-line-editor"
					>
						<input
							type="hidden"
							name="lineIdentity"
							value={row.lineItemId ? `id:${row.lineItemId}` : `new:${row.key}`}
						/>
						<label class="block text-xs font-semibold"
							>{i === values.lines.length ? 'New service or adjustment' : 'Description'}<input
								class={input}
								name="description"
								value={row.description}
								oninput={(e) => {
									if (i < values.lines.length) values.lines[i].description = e.currentTarget.value;
								}}
								maxlength="200"
							/></label
						>
						<label class="mt-2 block text-xs"
							>Detail<input
								class={input}
								name="subDescription"
								value={row.subDescription ?? ''}
								oninput={(e) => {
									if (i < values.lines.length)
										values.lines[i].subDescription = e.currentTarget.value;
								}}
								maxlength="500"
							/></label
						>
						<div class="mt-2 grid grid-cols-3 gap-2">
							<label class="text-xs"
								>Quantity<input
									class={input}
									name="quantity"
									value={row.quantity ?? ''}
									oninput={(e) => {
										if (i < values.lines.length) values.lines[i].quantity = e.currentTarget.value;
									}}
									inputmode="decimal"
								/></label
							>
							<label class="text-xs"
								>Unit price<input
									class={input}
									name="unitPrice"
									value={row.unitPrice}
									oninput={(e) => {
										if (i < values.lines.length) values.lines[i].unitPrice = e.currentTarget.value;
									}}
									inputmode="decimal"
								/></label
							>
							<label class="text-xs"
								>Line tax<input
									class={input}
									name="taxAmount"
									value={row.taxAmount}
									oninput={(e) => {
										if (i < values.lines.length) values.lines[i].taxAmount = e.currentTarget.value;
									}}
									inputmode="decimal"
								/></label
							>
						</div>
						<label class="mt-2 block text-xs"
							>Reason or service note<input
								class={input}
								name="note"
								value={row.note}
								oninput={(e) => {
									if (i < values.lines.length) values.lines[i].note = e.currentTarget.value;
								}}
								maxlength="500"
							/></label
						>
						{#if i < values.lines.length}<div class="mt-2 flex gap-3 text-xs">
								<button
									type={hydrated ? 'button' : 'submit'}
									name="rowAction"
									value={`up:${i}`}
									disabled={i === 0}
									onclick={() => {
										if (hydrated) move(i, -1);
									}}>Move up</button
								>
								<button
									type={hydrated ? 'button' : 'submit'}
									name="rowAction"
									value={`down:${i}`}
									disabled={i === values.lines.length - 1}
									onclick={() => {
										if (hydrated) move(i, 1);
									}}>Move down</button
								>
								<button
									type={hydrated ? 'button' : 'submit'}
									name="rowAction"
									value={`remove:${i}`}
									onclick={() => {
										if (hydrated) remove(i);
									}}>Remove</button
								>
							</div>{/if}
					</div>
				{/each}
			</div>
			{#if hydrated}<div class="my-3 flex flex-wrap gap-3 text-xs">
					<button type="button" onclick={() => add()}>+ New service</button><button
						type="button"
						onclick={() => add('charge')}>+ Charge</button
					><button type="button" onclick={() => add('discount')}>+ Discount</button><button
						type="button"
						onclick={() => add('credit')}>+ Credit</button
					>
				</div>{/if}
			<p class="text-xs text-(--text-muted)">
				Leave quantity blank for a flat amount. Enter a negative unit price for a separate discount
				or credit. Nothing is rounded.
			</p>
			<h3 class="mt-5 text-xs font-semibold text-olive-800 uppercase">What you’ll serve</h3>
			<label class="block text-xs"
				>Approved service description<textarea
					class={input}
					name="planDescription"
					bind:value={values.description}
					maxlength="2000"></textarea></label
			>
			<div class="my-2 grid grid-cols-2 gap-3">
				<label class="text-xs"
					>Guests<input
						class={input}
						name="planGuestCount"
						bind:value={values.guestCount}
						inputmode="numeric"
					/></label
				><label class="text-xs"
					>Duration in minutes<input
						class={input}
						name="planDuration"
						bind:value={values.durationMinutes}
						inputmode="numeric"
					/></label
				>
			</div>
			<label class="block text-xs"
				>Service items, one per line<textarea
					class={input}
					name="planItems"
					bind:value={values.items}></textarea></label
			>
			<div class="mt-5">
				<DepositChoices
					suggestion={request.suggestedDepositTerms}
					currency={request.financial.currency}
					version={request.financial.version}
					values={values.deposit}
					errorField={fieldErrors.deposit
						? values.deposit.depositChoice === 'fixed'
							? 'depositAmount'
							: values.deposit.depositChoice === 'percentage'
								? 'depositPercentage'
								: 'depositChoice'
						: undefined}
				/>
			</div>
		</fieldset>
		{#if preview}<div class="my-5 border-t border-(--border-soft) pt-4" data-testid="quote-preview">
				<h3 class="text-xs font-semibold text-olive-800 uppercase">Quote preview</h3>
				{#each preview.lines as line (line.id)}<p class="flex justify-between text-sm">
						<span>{line.description} · {line.origin.toLowerCase()}</span><span
							>{formatMoney(line.total, line.currency)}</span
						>
					</p>{/each}
				<p data-testid="quote-total" class="flex justify-between font-semibold">
					<span>Total</span><span>{formatMoney(preview.total, preview.currency)}</span>
				</p>
				<p data-testid="quote-deposit" class="text-sm">
					Deposit {formatMoney(preview.deposit.requiredAmount.amount, preview.currency)}
				</p>
			</div>{/if}
		{#if dirty || pending}<p role="status" class="text-xs">
				{pending ? 'Updating…' : 'Preview required for current edits.'}
			</p>{/if}
		<div class="flex gap-3">
			<button
				type="submit"
				bind:this={previewButton}
				disabled={blocked || reviewRequired || pending}
				class="rounded-full border border-olive-300 px-4 py-2 text-sm">Update preview</button
			><Button
				type="submit"
				formaction="?quote&/issueQuote"
				disabled={blocked || reviewRequired || pending || (hydrated && (!preview || dirty))}
				>Issue quote</Button
			><a href={resolve('/(app)/requests/[inquiryId]', { inquiryId: request.inquiry.id })}>Cancel</a
			>
		</div>
	</form>
</Card>
