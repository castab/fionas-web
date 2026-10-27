<script lang="ts">
	import CategorizedSelections from '../categorized-selections.svelte';
	import QuoteLinesEditor from './quote-lines-editor.svelte';
	import ServiceSelectionsEditor from './service-selections-editor.svelte';
	import { enhance } from '$app/forms';
	import { onMount, untrack } from 'svelte';
	import { Button, Card } from '@fionas/ui';
	import { fieldInput, fieldLabel, groupCaps, hint, panelCaps } from './styles.js';
	import DepositChoices from '$lib/components/requests/deposit-choices.svelte';
	import type { CurrentStaffRequest } from '$lib/request-contract.js';
	import { initialQuoteValues, type QuoteActionResult } from '$lib/quote-builder.js';
	import { formatMoney } from '$lib/presentation.js';
	import { workspaceAction, type RequestListQuery } from '$lib/request-list.js';
	let {
		request,
		route,
		returnContext = null,
		result,
		blocked = false,
		pending = $bindable(false),
		onReviewRequired
	}: {
		request: CurrentStaffRequest;
		/** This workspace's URL, with its return context; reloads and Cancel go here. */
		route: string;
		/** The Requests index view this workspace was opened from; kept through every action. */
		returnContext?: RequestListQuery | null;
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
</script>

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
			<Button href={route} data-sveltekit-reload variant="secondary" size="sm"
				>Reload to review</Button
			>
		</div>{/if}
	<form
		method="POST"
		action={workspaceAction(returnContext, 'previewQuote', 'quote')}
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
			<QuoteLinesEditor
				bind:lines={values.lines}
				errors={fieldErrors}
				guestCount={values.guestCount}
				{hydrated}
				{changed}
				{editing}
			/>
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
				formaction={workspaceAction(returnContext, 'issueQuote', 'quote')}
				disabled={blocked || reviewRequired || pending || (hydrated && (!preview || dirty))}
				class="min-h-12 flex-[1.4_1_150px]">Issue quote</Button
			><Button href={route} variant="ghost" class="min-h-12 flex-[1_1_110px]">Cancel</Button>
		</div>
	</form>
</Card>
