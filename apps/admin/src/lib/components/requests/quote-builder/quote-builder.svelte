<script lang="ts">
	import CategorizedSelections from '../categorized-selections.svelte';
	import ServiceSelectionsEditor from './service-selections-editor.svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { onMount, untrack } from 'svelte';
	import { Button, Card } from '@fionas/ui';
	import { fieldInput, fieldLabel, groupCaps, hint, lineTool, panelCaps } from './styles.js';
	import DepositChoices from '$lib/components/requests/deposit-choices.svelte';
	import type { CurrentStaffRequest } from '$lib/request-contract.js';
	import {
		initialQuoteValues,
		type QuoteActionResult,
		type LineDraft
	} from '$lib/quote-builder.js';
	import { formatMoney } from '$lib/presentation.js';
	import { CURRENCY } from '$lib/currency.js';
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
	// Bound to the Button primitive's `ref`, whose fallback is null (undefined is rejected).
	let previewButton = $state<HTMLButtonElement | null>(null);
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
	const input = `w-full font-normal ${fieldInput}`;
	const pill =
		'min-h-11 px-4 py-2.5 text-[11px] not-disabled:hover:bg-cream-300/50 disabled:opacity-45';
	const blank = (): LineDraft => ({
		key: crypto.randomUUID(),
		description: '',
		unitPrice: '',
		taxAmount: '0.00',
		currency: CURRENCY,
		note: ''
	});
	const rows = $derived([
		...values.lines,
		{
			key: 'blank-row',
			description: '',
			unitPrice: '',
			taxAmount: '0.00',
			currency: CURRENCY,
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
	/** Marks the review stale while a field is mid-edit, without scheduling a preview. */
	function editing() {
		dirty = true;
		error = '';
		clearTimeout(timer);
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

{#snippet toolIcon(path: string)}
	<svg
		width="14"
		height="14"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="1.75"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"><path d={path}></path></svg
	>
{/snippet}

<Card
	variant="flat"
	data-testid="quote-builder"
	id="quote-builder"
	aria-label="Issue quote"
	class="flex flex-col gap-5 border-2 border-olive-700 p-[18px] sm:p-5"
>
	<div class="flex flex-col gap-1">
		<h2 class={panelCaps}>Issue quote</h2>
		<p class={hint}>
			Edit the final lines {request.inquiry.name} will see. Totals and the deposit come back from the
			preview — check it before issuing.
		</p>
	</div>
	{#if error}<p role="alert" class="m-0 text-sm text-rust-600">{error}</p>{/if}
	{#if Object.keys(fieldErrors).length}<p role="alert" class="m-0 text-sm text-rust-600">
			{Object.values(fieldErrors).join(' ')}
		</p>{/if}
	{#if reviewStale}<p role="status" class="m-0 text-sm font-semibold">
			The quote changed since you reviewed it. Review this preview, then click Issue quote again.
		</p>{/if}
	{#if reviewRequired}<div class="flex flex-col items-start gap-3">
			<p role="alert" class="m-0 text-sm text-rust-600">
				Reload this request to review the latest state.
			</p>
			<Button
				href={resolve('/(app)/requests/[inquiryId]', { inquiryId: request.inquiry.id })}
				data-sveltekit-reload
				variant="secondary"
				size="sm">Reload to review</Button
			>
		</div>{/if}
	<form
		method="POST"
		action="?quote&/previewQuote"
		class="flex flex-col gap-5"
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
		<fieldset
			disabled={blocked || reviewRequired || pending}
			class="m-0 flex min-w-0 flex-col gap-5 border-0 p-0"
		>
			<fieldset class="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
				<legend class={`mb-3 ${panelCaps}`}>Final quote lines</legend>
				{#each rows as row, i (row.lineItemId ?? row.key)}
					<div
						class="flex flex-col gap-2.5 rounded-input bg-cream-200 px-3.5 pt-3 pb-3.5"
						data-testid="quote-line-editor"
					>
						<input
							type="hidden"
							name="lineIdentity"
							value={row.lineItemId ? `id:${row.lineItemId}` : `new:${row.key}`}
						/>
						<div class="flex flex-wrap items-center gap-1">
							<span class={`flex-1 ${groupCaps}`}>
								{i === values.lines.length
									? 'Add a line'
									: `Line ${i + 1} · ${row.lineItemId ? 'from Estimate' : 'new'}`}
							</span>
							{#if i < values.lines.length}
								<button
									type={hydrated ? 'button' : 'submit'}
									name="rowAction"
									value={`up:${i}`}
									disabled={i === 0}
									class={lineTool}
									onclick={() => {
										if (hydrated) move(i, -1);
									}}>{@render toolIcon('m18 15-6-6-6 6')}Move up</button
								>
								<button
									type={hydrated ? 'button' : 'submit'}
									name="rowAction"
									value={`down:${i}`}
									disabled={i === values.lines.length - 1}
									class={lineTool}
									onclick={() => {
										if (hydrated) move(i, 1);
									}}>{@render toolIcon('m6 9 6 6 6-6')}Move down</button
								>
								<button
									type={hydrated ? 'button' : 'submit'}
									name="rowAction"
									value={`remove:${i}`}
									class={`${lineTool} text-rust-600`}
									onclick={() => {
										if (hydrated) remove(i);
									}}>{@render toolIcon('M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14')}Remove</button
								>
							{/if}
						</div>
						<div class="grid grid-cols-1 gap-2.5 min-[480px]:grid-cols-2">
							<label class={fieldLabel}
								>{i === values.lines.length ? 'New service or adjustment' : 'Description'}<input
									class={input}
									name="description"
									value={row.description}
									oninput={(e) => {
										if (i < values.lines.length)
											values.lines[i].description = e.currentTarget.value;
									}}
									maxlength="200"
								/></label
							>
							<label class={fieldLabel}
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
						</div>
						<div class="grid grid-cols-3 gap-2.5">
							<label class={fieldLabel}
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
							<label class={fieldLabel}
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
							<label class={fieldLabel}
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
						<label class={fieldLabel}
							>Reason or service note<input
								class={input}
								name="note"
								value={row.note}
								placeholder="Optional — why this line changed"
								oninput={(e) => {
									if (i < values.lines.length) values.lines[i].note = e.currentTarget.value;
								}}
								maxlength="500"
							/></label
						>
					</div>
				{/each}
				{#if hydrated}<div class="flex flex-wrap gap-2">
						<Button type="button" variant="secondary" class={pill} onclick={() => add()}
							>+ Add service</Button
						><Button type="button" variant="secondary" class={pill} onclick={() => add('charge')}
							>+ Charge</Button
						><Button type="button" variant="secondary" class={pill} onclick={() => add('discount')}
							>+ Discount</Button
						><Button type="button" variant="secondary" class={pill} onclick={() => add('credit')}
							>+ Credit</Button
						>
					</div>{/if}
				<p class={hint}>
					Leave quantity blank for a flat amount. Enter a negative unit price for a separate
					discount or credit. Nothing is rounded.
				</p>
			</fieldset>
			<div class="flex flex-col gap-3 border-t border-(--border-soft) pt-[18px]">
				<h3 class={panelCaps}>What you’ll serve</h3>
				<label class={fieldLabel}
					>Approved service description<textarea
						class={`${input} min-h-20`}
						name="planDescription"
						bind:value={values.description}
						maxlength="2000"></textarea></label
				>
				<div class="grid grid-cols-1 gap-2.5 min-[480px]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
					<label class={fieldLabel}
						>Guests<input
							class={input}
							name="planGuestCount"
							bind:value={values.guestCount}
							inputmode="numeric"
						/></label
					>
				</div>
				{#if !values.description.trim()}<p role="status" class={hint}>
						Without an approved service description, no serving plan or selections will accompany
						this Quote.
					</p>{/if}
				<ServiceSelectionsEditor
					bind:items={values.items}
					errors={fieldErrors}
					{hydrated}
					{changed}
					{editing}
				/>
			</div>
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
		</fieldset>
		{#if preview}<div
				aria-live="polite"
				class="flex flex-col gap-3 rounded-input bg-cream-200 p-3.5"
				data-testid="quote-preview"
			>
				<div class="flex flex-wrap items-center justify-between gap-2">
					<h3 class={panelCaps}>Quote preview</h3>
					<span class={`rounded-full border border-olive-300 px-2.5 py-1 ${groupCaps}`}
						>Quote v{preview.quoteVersion} · not issued yet</span
					>
				</div>
				{#if preview.servicePlan}<div
						class="flex flex-col gap-2.5 border-b border-(--border-soft) pb-3"
						data-testid="preview-service-plan"
					>
						<p class={groupCaps}>
							You’ll approve{preview.servicePlan.guestCount
								? ` · ${preview.servicePlan.guestCount} guest${preview.servicePlan.guestCount === 1 ? '' : 's'}`
								: ''}
						</p>
						<p class="m-0 text-[13px] leading-[1.6] wrap-anywhere whitespace-pre-wrap">
							{preview.servicePlan.description}
						</p>
						<CategorizedSelections items={preview.servicePlan.items} headingLevel={4} inset />
					</div>{/if}
				<ul class="m-0 flex list-none flex-col p-0 text-[13px]">
					{#each preview.lines as line (line.id)}<li
							class="flex justify-between gap-3 border-b border-(--border-soft) py-[7px]"
						>
							<span class="min-w-0 wrap-anywhere"
								>{line.description}
								<span class="text-(--text-muted)"
									>· {line.quantity !== undefined
										? `${line.quantity} × ${formatMoney(line.unitPrice, line.currency)}`
										: 'flat'}{line.origin === 'NEW'
										? ' · new'
										: line.origin === 'REPLACED'
											? ' · changed'
											: ''}</span
								></span
							><span class="font-semibold whitespace-nowrap"
								>{formatMoney(line.total, line.currency)}</span
							>
						</li>{/each}
				</ul>
				<dl class="m-0 flex flex-col gap-1.5 text-[13px]">
					<div class="flex justify-between gap-3">
						<dt class="text-(--text-muted)">Subtotal</dt>
						<dd class="m-0">{formatMoney(preview.subtotal, preview.currency)}</dd>
					</div>
					<div class="flex justify-between gap-3">
						<dt class="text-(--text-muted)">Tax</dt>
						<dd class="m-0">{formatMoney(preview.taxAmount, preview.currency)}</dd>
					</div>
					<div
						data-testid="quote-total"
						class="flex justify-between gap-3 border-t border-(--border-soft) pt-2 text-[15px] font-bold text-(--text-heading)"
					>
						<dt>Total</dt>
						<dd class="m-0">{formatMoney(preview.total, preview.currency)}</dd>
					</div>
					<div data-testid="quote-deposit" class="flex justify-between gap-3 font-semibold">
						<dt>Deposit to hold the date</dt>
						<dd class="m-0">
							{formatMoney(preview.deposit.requiredAmount.amount, preview.currency)}
						</dd>
					</div>
				</dl>
			</div>{/if}
		{#if dirty || pending}<p role="status" class="m-0 text-xs text-(--text-muted)">
				{pending ? 'Updating…' : 'Preview required for current edits.'}
			</p>{/if}
		<!-- Update preview stays first in the DOM so Enter in a field previews instead of issuing. -->
		<div class="flex flex-wrap gap-2.5">
			<Button
				type="submit"
				variant="secondary"
				bind:ref={previewButton}
				disabled={blocked || reviewRequired || pending}
				class="min-h-12 flex-[1_1_140px]">Update preview</Button
			><Button
				type="submit"
				formaction="?quote&/issueQuote"
				disabled={blocked || reviewRequired || pending || (hydrated && (!preview || dirty))}
				class="min-h-12 flex-[1.4_1_150px]">Issue quote</Button
			><Button
				href={resolve('/(app)/requests/[inquiryId]', { inquiryId: request.inquiry.id })}
				variant="ghost"
				class="min-h-12 flex-[1_1_110px]">Cancel</Button
			>
		</div>
	</form>
</Card>
