<script lang="ts">
	import EditorPreviewPanel from './editor-preview.svelte';
	import QuoteLinesEditor from './quote-lines-editor.svelte';
	import ServicePlanControls from './service-plan-controls.svelte';
	import ServiceSelectionsEditor from './service-selections-editor.svelte';
	import { enhance } from '$app/forms';
	import { onMount, untrack } from 'svelte';
	import { Button, Card } from '@fionas/ui';
	import { fieldInput, fieldLabel, hint, panelCaps } from './styles.js';
	import DepositChoices from '$lib/components/requests/deposit-choices.svelte';
	import {
		editorActions,
		editorCopy,
		editorPanels,
		editsDeposit,
		isRevision,
		type FinancialEditorMode
	} from '$lib/financial-editor.js';
	import { depositTermsLabel } from '$lib/deposit.js';
	import type { CurrentStaffRequest } from '$lib/request-contract.js';
	import { editorValues, type QuoteActionResult } from '$lib/quote-builder.js';
	import { droppedNotes } from '$lib/service-plan-edit.js';
	import { formatMoney } from '$lib/presentation.js';
	import { workspaceAction, type RequestListQuery } from '$lib/request-list.js';
	let {
		request,
		mode,
		route,
		returnContext = null,
		result,
		blocked = false,
		focusOnOpen = false,
		pending = $bindable(false),
		onReviewRequired
	}: {
		request: CurrentStaffRequest;
		mode: FinancialEditorMode;
		/** This workspace's URL, with its return context; reloads and Cancel go here. */
		route: string;
		/** The Requests index view this workspace was opened from; kept through every action. */
		returnContext?: RequestListQuery | null;
		result: QuoteActionResult | null;
		blocked?: boolean;
		/** Move focus to the panel when opened by its link rather than returned by a submission. */
		focusOnOpen?: boolean;
		pending?: boolean;
		onReviewRequired: () => void;
	} = $props();
	const copy = $derived(editorCopy[mode]);
	const actions = $derived(editorActions[mode]);
	const panel = $derived(editorPanels[mode]);
	const seed = untrack(() => result);
	let values = $state(untrack(() => seed?.quoteValues ?? editorValues(request, mode)));
	let preview = $state(seed?.preview ?? null);
	let error = $state(seed?.quoteError ?? '');
	let fieldErrors = $state(seed?.fieldErrors ?? {});
	let reviewRequired = $state(seed?.reviewRequired ?? false);
	let reviewStale = $state(seed?.notices?.reviewStale ?? false);
	let noChange = $state(seed?.notices?.noChange ?? false);
	let dirty = $state(false);
	let hydrated = $state(false);
	let formElement = $state<HTMLFormElement>();
	let heading = $state<HTMLElement>();
	// Bound to the Button primitive's `ref`, whose fallback is null (undefined is rejected).
	let previewButton = $state<HTMLButtonElement | null>(null);
	let timer: ReturnType<typeof setTimeout>;
	let sequence = 0;
	let previewController: AbortController | undefined;
	onMount(() => {
		hydrated = true;
		if (focusOnOpen) heading?.focus();
		return () => {
			clearTimeout(timer);
			previewController?.abort();
		};
	});
	const input = `w-full font-normal ${fieldInput}`;
	const dropped = $derived(isRevision(mode) ? droppedNotes(values, request) : []);
	const accepted = $derived(
		request.depositRequirement.state === 'ACTIVE' ? request.depositRequirement : null
	);
	function changed() {
		dirty = true;
		error = '';
		noChange = false;
		clearTimeout(timer);
		if (hydrated && !pending && !reviewRequired)
			timer = setTimeout(() => formElement?.requestSubmit(previewButton), 300);
	}
	/** Marks the review stale while a field is mid-edit, without scheduling a preview. */
	function editing() {
		dirty = true;
		error = '';
		noChange = false;
		clearTimeout(timer);
	}
</script>

<Card
	variant="flat"
	data-testid="quote-builder"
	data-mode={mode}
	id="quote-builder"
	aria-labelledby="quote-builder-title"
	class="flex flex-col gap-5 border-2 border-olive-700 p-[18px] sm:p-5"
>
	<div class="flex flex-col gap-1">
		<h2 id="quote-builder-title" bind:this={heading} tabindex="-1" class={panelCaps}>
			{copy.title}
		</h2>
		<p class={hint}>{copy.intro(request.inquiry.name)}</p>
	</div>
	{#if error}<p role="alert" class="m-0 text-sm text-rust-600">{error}</p>{/if}
	{#if Object.keys(fieldErrors).length}<p role="alert" class="m-0 text-sm text-rust-600">
			{Object.values(fieldErrors).join(' ')}
		</p>{/if}
	{#if noChange}<p role="status" class="m-0 text-sm font-semibold" data-testid="no-material-change">
			Nothing has changed. Update the pricing or service details before publishing a new version.
		</p>{/if}
	{#if reviewStale}<p role="status" class="m-0 text-sm font-semibold">
			The {mode === 'INITIAL_QUOTE' ? 'quote' : 'booking'} changed since you reviewed it. Review this
			preview, then click {copy.publishVerb} again.
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
		action={workspaceAction(returnContext, actions.preview, panel)}
		class="flex flex-col gap-5"
		bind:this={formElement}
		oninput={changed}
		onchange={changed}
		use:enhance={({ submitter, controller }) => {
			const issuing =
				submitter?.getAttribute('formaction')?.includes(`/${actions.publish}`) ?? false;
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
					error = 'We couldn’t confirm the response. Reload before publishing.';
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
				noChange = data.notices?.noChange ?? false;
				dirty = !data.preview;
				if (reviewRequired) onReviewRequired();
			};
		}}
	>
		<input type="hidden" name="editorMode" value={values.mode} />
		<input type="hidden" name="reviewedCurrency" value={values.reviewedCurrency} />
		<input type="hidden" name="reviewToken" value={values.reviewToken} />
		<input type="hidden" name="reviewedFingerprint" value={values.reviewedFingerprint} />
		<input type="hidden" name="expectedDepositRevision" value={values.expectedDepositRevision} />
		<input type="hidden" name="expectedProposalId" value={values.expectedProposalId} />
		<input type="hidden" name="expectedPlanRevision" value={values.expectedPlanRevision} />
		{#if !editsDeposit(mode)}<input
				type="hidden"
				name="expectedVersion"
				value={values.expectedVersion}
			/>{/if}
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
				{#if isRevision(mode)}
					<ServicePlanControls {request} bind:clearPlan={values.clearPlan} {dropped} />
				{/if}
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
				{#if mode === 'INITIAL_QUOTE' && !values.description.trim()}<p role="status" class={hint}>
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
			{#if editsDeposit(mode) && values.deposit}
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
			{:else if accepted}
				<!-- Immutable once booked: shown for context, never a field and never posted. -->
				<div
					class="flex flex-col gap-1 border-t border-(--border-soft) pt-[18px]"
					data-testid="accepted-deposit"
				>
					<h3 class={panelCaps}>Accepted deposit</h3>
					<p class="m-0 text-[13.5px] font-semibold">
						{formatMoney(accepted.requiredAmount.amount, accepted.requiredAmount.currency)}
						<span class="font-normal text-(--text-muted)"
							>· {depositTermsLabel(accepted.terms)}</span
						>
					</p>
					<p class={hint}>
						The deposit that booked this event stays as accepted. Added charges or reductions change
						the invoice balance, not the deposit.
					</p>
				</div>
			{/if}
		</fieldset>
		{#if preview}<EditorPreviewPanel {preview} {request} />{/if}
		{#if dirty || pending}<p role="status" class="m-0 text-xs text-(--text-muted)">
				{pending ? 'Updating…' : copy.pendingPreview}
			</p>{/if}
		<!-- Update preview stays first in the DOM so Enter in a field previews instead of publishing. -->
		<div class="flex flex-wrap gap-2.5">
			<Button
				type="submit"
				variant="secondary"
				bind:ref={previewButton}
				disabled={blocked || reviewRequired || pending}
				class="min-h-12 flex-[1_1_140px]">Update preview</Button
			><Button
				type="submit"
				formaction={workspaceAction(returnContext, actions.publish, panel)}
				disabled={blocked || reviewRequired || pending || (hydrated && (!preview || dirty))}
				class="min-h-12 flex-[1.4_1_150px]">{copy.publish}</Button
			><Button href={route} variant="ghost" class="min-h-12 flex-[1_1_110px]">Cancel</Button>
		</div>
	</form>
</Card>
