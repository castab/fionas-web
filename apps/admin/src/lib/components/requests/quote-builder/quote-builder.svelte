<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { applyAction, enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { Button, Card } from '@fionas/ui';
	import DepositChoices from '$lib/components/requests/deposit-choices.svelte';
	import ServicePicks from './service-picks.svelte';
	import QuoteLines from './quote-lines.svelte';
	import type { CurrentStaffRequest } from '$lib/request-contract.js';
	import type { InquiryQuotePreviewResponse, QuotePreviewLine } from '$lib/quote-contract.js';
	import {
		basisNotice,
		effectiveConfiguration,
		isActiveOverride,
		isBlankAdjustment,
		lineTarget,
		quoteInputErrors,
		readQuoteForm,
		targetKey,
		type AdjustmentDraft,
		type BuilderChoices,
		type FeedbackSection,
		type QuoteActionResult as QuoteResult,
		type QuoteFieldErrors,
		type QuoteNotices
	} from '$lib/quote-builder.js';
	import { depositTermsLabel } from '$lib/deposit.js';
	import { formatMoney } from '$lib/presentation.js';
	import { errorText, hint, panelCaps } from './styles.js';

	let {
		request,
		choices,
		result,
		route,
		blocked = false,
		pending = $bindable(false),
		onReviewRequired
	}: {
		request: CurrentStaffRequest;
		choices: BuilderChoices | null;
		/** The quote actions' result from a native POST render; enhanced results stay local. */
		result: QuoteResult | null;
		/** The request's clean pathname (Cancel and reload). */
		route: string;
		/** Another mutation needs review first: nothing may be issued. */
		blocked?: boolean;
		pending?: boolean;
		onReviewRequired: () => void;
	} = $props();

	const PREVIEW_ACTION = '?quote&/previewQuote';
	const ISSUE_ACTION = '?quote&/issueQuote';
	const DEBOUNCE_MS = 600;
	const currency = $derived(request.financial.currency);
	const effective = $derived(effectiveConfiguration(request));
	const firstName = $derived(request.inquiry.name.trim().split(/\s+/)[0] || 'them');

	// Seeded once from the server render; enhanced results then update these in place.
	const seed = untrack(() => result);
	let enhanced = $state(false);
	let preview = $state<InquiryQuotePreviewResponse | null>(seed?.preview ?? null);
	let reviewed = $state({
		token: seed?.quoteValues?.reviewToken ?? '',
		basis: seed?.quoteValues?.reviewedBasis ?? '',
		fingerprint: seed?.quoteValues?.reviewedFingerprint ?? ''
	});
	let notices = $state<QuoteNotices>(seed?.notices ?? {});
	let quoteError = $state<string | null>(seed?.quoteError ?? null);
	let reviewRequired = $state(seed?.reviewRequired ?? false);
	let serverErrors = $state<QuoteFieldErrors>(seed?.fieldErrors ?? {});
	let feedback = $state<Partial<Record<FeedbackSection, string[]>>>(seed?.feedback ?? {});
	let overrides = $state<Record<string, { amount: string; reason: string }>>(
		Object.fromEntries(
			(seed?.quoteValues?.overrides ?? []).map((o) => [
				o.key,
				{ amount: o.amount, reason: o.reason }
			])
		)
	);
	let adjustments = $state<AdjustmentDraft[]>(
		(seed?.quoteValues?.adjustments ?? []).filter((row) => !isBlankAdjustment(row))
	);
	let submitting = $state<'preview' | 'issue' | null>(null);
	let clientErrors = $state<QuoteFieldErrors>({});
	let touched = $state(new Set<string>());
	let currentSnapshot = $state('');
	let previewSnapshot = $state<string | null>(null);
	let formElement = $state<HTMLFormElement | null>(null);
	let previewButton = $state<HTMLButtonElement | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let latest: AbortController | undefined;
	let sequence = 0;
	let keyCounter = 0;

	const serviceLines = $derived<QuotePreviewLine[]>(
		preview
			? preview.lines.filter((line) => line.origin.type !== 'ADJUSTMENT')
			: request.financial.lines.map((line) => ({
					...line,
					lineItemId: line.id,
					origin: { type: 'ESTIMATE_LINE' as const }
				}))
	);
	const adjustmentLines = $derived(
		preview ? preview.lines.filter((line) => line.origin.type === 'ADJUSTMENT') : []
	);
	const errors = $derived<QuoteFieldErrors>({
		...Object.fromEntries(Object.entries(clientErrors).filter(([field]) => touched.has(field))),
		...serverErrors
	});
	const dirty = $derived(enhanced && previewSnapshot !== currentSnapshot);
	const canIssue = $derived(
		!blocked &&
			!reviewRequired &&
			!submitting &&
			(!enhanced || (!!preview && !!reviewed.token && !dirty))
	);
	const notice = $derived(preview ? basisNotice(preview.pricingBasis) : null);
	const depositError = $derived(
		errors.depositPercentage
			? 'depositPercentage'
			: errors.depositAmount
				? 'depositAmount'
				: undefined
	);

	/** What the server would compose from the form: only intent, never presentation fields. */
	function snapshotOf(data: FormData): string {
		const values = readQuoteForm(data);
		if (!values) return 'invalid';
		return JSON.stringify({
			deposit: values.deposit,
			service: values.service,
			overrides: values.overrides
				.filter((o) => isActiveOverride(o, currency))
				.map(({ key, amount, reason }) => ({ key, amount, reason })),
			adjustments: values.adjustments.filter((row) => !isBlankAdjustment(row))
		});
	}
	function formData(): FormData | null {
		return formElement ? new FormData(formElement) : null;
	}

	function edited() {
		const data = formData();
		if (!data) return;
		currentSnapshot = snapshotOf(data);
		const values = readQuoteForm(data);
		clientErrors = values ? quoteInputErrors(values, currency) : {};
		serverErrors = {};
		clearTimeout(timer);
		if (currentSnapshot === previewSnapshot || reviewRequired || blocked) return;
		if (Object.keys(clientErrors).length) return;
		timer = setTimeout(() => formElement?.requestSubmit(previewButton), DEBOUNCE_MS);
	}

	/** Overrides for lines the latest preview no longer has can never be posted; forget them. */
	function forgetMissingOverrides(lines: QuotePreviewLine[]) {
		const keys = new Set(
			lines.flatMap((line) => {
				const target = lineTarget(line);
				return target ? [targetKey(target)] : [];
			})
		);
		for (const key of Object.keys(overrides)) if (!keys.has(key)) delete overrides[key];
	}

	onMount(() => {
		enhanced = true;
		void tick().then(() => {
			const data = formData();
			if (!data) return;
			currentSnapshot = snapshotOf(data);
			if (preview && reviewed.token) previewSnapshot = currentSnapshot;
			else if (!reviewRequired && !blocked) formElement?.requestSubmit(previewButton);
		});
		return () => clearTimeout(timer);
	});
</script>

<Card
	variant="flat"
	id="quote-builder"
	class="flex scroll-mt-4 flex-col gap-4 border-2 border-olive-700 p-[18px] sm:p-5"
	data-testid="quote-builder"
>
	<!-- Clicks only observe chip and line buttons (keyboard activation also clicks) to refresh the preview. -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
	<form
		bind:this={formElement}
		method="POST"
		action={PREVIEW_ACTION}
		class="flex flex-col gap-4"
		aria-busy={!!submitting}
		oninput={edited}
		onchange={edited}
		onclick={() => void tick().then(edited)}
		onfocusout={(event) => {
			const name = (event.target as HTMLInputElement | null)?.name;
			if (name) touched = new Set([...touched, name]);
		}}
		use:enhance={({ submitter, cancel, controller, formData }) => {
			const action = submitter?.getAttribute('formaction') === ISSUE_ACTION ? 'issue' : 'preview';
			clearTimeout(timer);
			if (action === 'issue' && (!canIssue || pending)) {
				cancel();
				return;
			}
			if (action === 'preview' && (submitting === 'issue' || reviewRequired || blocked)) {
				cancel();
				return;
			}
			if (submitter) touched = new Set([...touched, ...formData.keys()]);
			latest?.abort();
			latest = controller;
			const submitted = snapshotOf(formData);
			const id = ++sequence;
			submitting = action;
			if (action === 'issue') pending = true;
			return async ({ result: outcome }) => {
				if (id !== sequence) return;
				try {
					if (outcome.type === 'redirect') {
						await applyAction(outcome);
						return;
					}
					if (outcome.type === 'error') {
						quoteError =
							action === 'issue'
								? 'We couldn’t confirm whether the quote was issued. Reload to review the latest state before trying again.'
								: 'We couldn’t preview this quote just now. Nothing was issued — try again.';
						if (action === 'issue') {
							reviewRequired = true;
							onReviewRequired();
						}
						previewSnapshot = null;
						return;
					}
					const data = (outcome.data ?? {}) as QuoteResult;
					notices = data.notices ?? {};
					feedback = data.feedback ?? {};
					serverErrors = data.fieldErrors ?? {};
					quoteError = data.quoteError ?? null;
					if (outcome.type === 'success' && data.preview && data.quoteValues) {
						preview = data.preview;
						reviewed = {
							token: data.quoteValues.reviewToken,
							basis: data.quoteValues.reviewedBasis,
							fingerprint: data.quoteValues.reviewedFingerprint
						};
						previewSnapshot = submitted;
						forgetMissingOverrides(data.preview.lines);
						await tick();
						edited();
						return;
					}
					previewSnapshot = null;
					if (data.reviewRequired) {
						reviewRequired = true;
						onReviewRequired();
					}
					if (data.catalogStale) await invalidateAll();
				} finally {
					if (id === sequence) {
						submitting = null;
						if (action === 'issue') pending = false;
					}
				}
			};
		}}
	>
		<!-- First submit button: Enter in a field previews, it never issues. -->
		<button
			bind:this={previewButton}
			type="submit"
			formaction={PREVIEW_ACTION}
			hidden
			tabindex="-1"
			aria-hidden="true"
			disabled={reviewRequired || blocked}
		>
			Update preview
		</button>
		<input type="hidden" name="reviewToken" value={reviewed.token} />
		<input type="hidden" name="reviewedBasis" value={reviewed.basis} />
		<input type="hidden" name="reviewedFingerprint" value={reviewed.fingerprint} />

		<div class="flex flex-col gap-1">
			<h2 class={panelCaps}>Formal quote</h2>
			<p class={hint}>
				Started from their estimate — adjust each line after checking ingredients, supplies &amp;
				staffing for the date. Issuing publishes the quote and its deposit; nothing is sent to {firstName}.
			</p>
		</div>

		<ServicePicks
			{choices}
			{effective}
			initial={seed?.quoteValues?.service ?? null}
			reviewed={preview?.service ?? null}
			{enhanced}
			{errors}
			feedback={feedback.service}
			disabled={reviewRequired || blocked}
		/>

		<QuoteLines
			lines={serviceLines}
			{adjustmentLines}
			bind:overrides
			bind:adjustments
			{currency}
			{enhanced}
			{errors}
			lineFeedback={feedback.lines}
			adjustmentFeedback={feedback.adjustments}
			disabled={reviewRequired || blocked}
			newKey={() => `line-${Date.now().toString(36)}-${++keyCounter}`}
		/>

		<div class="flex flex-col gap-2" data-testid="quote-total">
			<div class="flex items-baseline border-t-2 border-olive-700 pt-2.5">
				<span class={panelCaps}>Quote total</span>
				<span class="flex-1"></span>
				<span
					aria-live="polite"
					class={[
						'text-[22px] leading-[1.3] font-bold text-olive-900 transition-opacity duration-(--dur-fast) ease-(--ease-out)',
						(dirty || submitting === 'preview') && 'opacity-45'
					]}>{preview ? formatMoney(preview.total, currency) : '—'}</span
				>
			</div>
			<p class={`${hint} text-right`} aria-live="polite">
				{#if submitting === 'preview'}Updating preview…{:else if dirty}Changes not previewed yet{:else if preview && preview.estimateTotal !== preview.total}Their
					estimate was {formatMoney(preview.estimateTotal, currency)}{:else if !preview}Preview the
					quote to see its total{/if}
			</p>
			{#if notice}
				<p
					class={[
						'm-0 rounded-input border px-3 py-2 text-xs leading-[1.55]',
						notice.tone === 'strong'
							? 'border-rust-600/40 bg-cream-200 font-semibold text-ink-700'
							: 'border-(--border-soft) bg-cream-200 text-(--text-muted)'
					]}
					data-testid="quote-basis"
				>
					{notice.text}
				</p>
			{/if}
			{#if notices.repriced}<p class={hint} role="status">
					Those pick changes affect the price, so the whole quote is recalculated from today’s
					catalog.
				</p>{/if}
			{#if notices.overridesCleared}<p class={hint} role="status">
					Line price changes were cleared because the lines were recalculated. Re-enter any you
					still need.
				</p>{/if}
			{#each feedback.total ?? [] as text (text)}<p class={errorText} role="alert">{text}</p>{/each}
		</div>

		<div>
			<DepositChoices
				suggestion={request.suggestedDepositTerms}
				currency={request.financial.currency}
				version={request.financial.version}
				values={seed?.quoteValues?.deposit}
				errorField={depositError}
				disabled={reviewRequired || blocked}
			/>
			{#if preview}
				<p class="m-0 -mt-1 text-sm" data-testid="quote-deposit">
					<span class="font-semibold"
						>Deposit to hold the date: {formatMoney(
							preview.deposit.requiredAmount.amount,
							preview.deposit.requiredAmount.currency
						)}</span
					>
					<span class="text-xs text-(--text-muted)">
						· {depositTermsLabel(preview.deposit.terms)}</span
					>
				</p>
			{/if}
		</div>

		{#if notices.reviewStale}
			<p class="m-0 text-sm font-semibold text-ink-700" role="status">
				The quote changed since you reviewed it. Check this new preview, then issue again.
			</p>
		{/if}
		{#each feedback.form ?? [] as text (text)}<p class={errorText} role="alert">{text}</p>{/each}
		{#if quoteError}
			<div role="alert" class="flex flex-col items-start gap-3">
				<p id="deposit-error" class="m-0 text-[12.5px] text-rust-600">{quoteError}</p>
				{#if reviewRequired}
					<Button href={route} data-sveltekit-reload variant="secondary" size="sm"
						>Reload to review</Button
					>
				{:else if enhanced}
					<Button
						type="button"
						variant="secondary"
						size="sm"
						onclick={() => formElement?.requestSubmit(previewButton)}>Preview again</Button
					>
				{/if}
			</div>
		{/if}

		<div class="flex flex-wrap gap-2.5">
			{#if !enhanced}
				<Button
					type="submit"
					formaction={PREVIEW_ACTION}
					variant="secondary"
					disabled={reviewRequired || blocked}
					class="min-h-[50px] min-w-[150px] flex-1 text-[12.5px]">Update preview</Button
				>
			{/if}
			<Button
				type="submit"
				formaction={ISSUE_ACTION}
				disabled={!canIssue}
				class="min-h-[50px] min-w-[150px] flex-[1.4] text-[12.5px]"
				>{submitting === 'issue' ? 'Issuing quote…' : 'Issue quote'}</Button
			>
			<Button
				href={route}
				variant="secondary"
				class="min-h-[50px] min-w-[120px] flex-1 text-[12.5px]">Cancel</Button
			>
		</div>
	</form>
</Card>
