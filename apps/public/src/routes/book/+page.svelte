<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount, tick, untrack } from 'svelte';
	import { Button, Card, capsSm, capsXs, cn, hintText } from '@fionas/ui';
	import {
		emptyAnswers,
		instagramUrl,
		isSkippable,
		mailtoUrl,
		prepareInquiry,
		site,
		validateAnswers,
		type FieldErrors,
		type InquiryForm,
		type InquiryFormField,
		type InquiryAnswers
	} from '@fionas/shared';
	import { missingSummary, swirlNote } from '$lib/booking-copy.js';
	import EstimatePanel from '$lib/components/estimate-panel.svelte';
	import InquiryField from '$lib/components/inquiry-field.svelte';
	import type { SubmissionFailure, SubmissionOutcome } from '$lib/inquiry-submission.js';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	/**
	 * Where the submission stands. Success never shows here: it redirects to /book/received.
	 * - `editing`: answering (also after a local validation failure)
	 * - `submitting`: a delivery is in flight
	 * - `ambiguous`: the last delivery may or may not have been recorded; answers are frozen
	 * - `review`: the prices changed; the refreshed form must be reviewed before sending
	 * - `failed`: a definite failure; fix or wait, then send again
	 */
	type Phase = 'editing' | 'submitting' | 'ambiguous' | 'review' | 'failed';

	type Review = { fields: string[]; unavailable: string[]; removed: number };

	function reviewOf(failed: SubmissionFailure | null | undefined): Review | null {
		if (!failed?.refreshedForm) return null;
		return {
			fields: failed.reviewFields ?? [],
			unavailable: failed.unavailableChoices ?? [],
			removed: failed.removedChoices ?? 0
		};
	}

	function phaseOf(failed: SubmissionFailure | null | undefined): Phase {
		if (!failed || failed.outcome === 'invalid') return 'editing';
		if (failed.refreshedForm) return 'review';
		return failed.outcome === 'ambiguous' ? 'ambiguous' : 'failed';
	}

	// A failed submit echoes its state back (all the no-JS path has). Only the initial values
	// matter here; after hydration the client owns this state.
	const initial = untrack(() => {
		const failed: SubmissionFailure | null = form ?? null;
		const inquiryForm = failed?.refreshedForm ?? data.form;
		return {
			inquiryForm,
			answers: inquiryForm ? (failed?.answers ?? emptyAnswers(inquiryForm)) : null,
			errors: failed?.errors ?? {},
			formError: failed?.formError ?? null,
			submissionToken: failed?.submissionToken ?? data.submissionToken,
			priceRevision: failed?.priceRevision ?? inquiryForm?.priceRevision ?? '',
			restartToken: failed?.restartToken ?? null,
			replay: failed?.replay?.envelope ?? null,
			outcome: failed?.outcome ?? null,
			review: reviewOf(failed),
			phase: phaseOf(failed)
		};
	});

	/** The form being answered: the loaded one, or the refreshed one after a price revision change. */
	let inquiryForm = $state.raw<InquiryForm | null>(initial.inquiryForm);
	let answers = $state<InquiryAnswers | null>(initial.answers);
	let errors = $state<FieldErrors>(initial.errors);
	let formError = $state<string | null>(initial.formError);
	let attempted = $state(Object.keys(initial.errors).length > 0 || initial.review !== null);
	let phase = $state<Phase>(initial.phase);
	let outcome = $state<SubmissionOutcome | null>(initial.outcome);

	/*
	 * The logical submission. Its token reaches the backend as `Idempotency-Key` and stays the same
	 * across double clicks and retries; only a reviewed price refresh or a deliberate restart (a new
	 * submission) replaces it. The revision pins the answers to the prices they were shown.
	 */
	let submissionToken = $state(initial.submissionToken);
	let priceRevision = $state(initial.priceRevision);
	/** After IDEMPOTENCY_KEY_REUSED or an unknown outcome: the key for a deliberate new submission. */
	let restartToken = $state<string | null>(initial.restartToken);
	/** After a price revision change: what the customer must look at again. */
	let review = $state<Review | null>(initial.review);
	/**
	 * After an unknown outcome: the exact request that was delivered under `submissionToken`. "Try
	 * sending again" posts it back and the server resends it unchanged, never a request rebuilt from
	 * the answers. Dropped the moment the customer starts a new submission.
	 */
	let replay = $state.raw<string | null>(initial.replay);
	/** The customer chose to change answers after an unknown outcome: this is a new submission. */
	let restarted = $state(false);
	/** The last delivery's outcome is unknown: answers stay frozen until a retry settles it. */
	let outcomeUnknown = $state(initial.phase === 'ambiguous');
	/** Controls that only work with JavaScript render after hydration. */
	let hydrated = $state(false);
	onMount(() => (hydrated = true));

	const submitting = $derived(phase === 'submitting');
	/**
	 * After an unknown outcome the answers are frozen (inert, but still submitted) and the delivered
	 * request rides along as `replayRequest`, so "Try sending again" repeats exactly the command that
	 * may already have been recorded, under the same key.
	 */
	const frozen = $derived(outcomeUnknown);
	/** The design's "Please add: …" line under the send button, once a send was attempted. */
	const missing = $derived(
		attempted && inquiryForm && !frozen ? missingSummary(inquiryForm, errors) : null
	);
	const picksOf = (key: string): string[] => {
		const value = answers?.values[key];
		return Array.isArray(value) ? value : [];
	};

	// Once the visitor has tried to submit, keep the messages in step with their edits.
	$effect(() => {
		if (attempted && inquiryForm && answers && !frozen) {
			errors = validateAnswers(inquiryForm, answers);
		}
	});

	function applyFailure(failed: SubmissionFailure | undefined) {
		if (failed?.refreshedForm) inquiryForm = failed.refreshedForm;
		if (failed?.answers) answers = failed.answers;
		if (failed?.submissionToken) submissionToken = failed.submissionToken;
		if (failed?.priceRevision) priceRevision = failed.priceRevision;
		restartToken = failed?.restartToken ?? null;
		replay = failed?.replay?.envelope ?? null;
		outcome = failed?.outcome ?? null;
		review = reviewOf(failed);
		phase = phaseOf(failed);
		outcomeUnknown = phase === 'ambiguous';
		if (failed?.refreshedForm || outcome === 'key_reused') restarted = false;
		formError = failed?.formError ?? null;
		errors =
			failed?.errors ?? (inquiryForm && answers ? validateAnswers(inquiryForm, answers) : {});
	}

	/** Unfreezes the answers for editing; what is sent next is a new submission under a new key. */
	function changeAnswers() {
		if (!restartToken) return;
		submissionToken = restartToken;
		restartToken = null;
		replay = null;
		outcomeUnknown = false;
		restarted = true;
		phase = 'editing';
		formError = null;
	}

	/** Short single-line answers sit two to a row; chip groups and notes take the full width. */
	const isCompact = (field: InquiryFormField) =>
		field.presentation.control === 'TEXT' ||
		field.presentation.control === 'DATE' ||
		field.presentation.control === 'NUMBER' ||
		(field.input.type === 'STRING_CHOICE' && field.presentation.control !== 'CHIPS');

	const listOf = (names: string[]) =>
		names.length < 2
			? (names[0] ?? '')
			: `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

	async function focusFirstError() {
		await tick();
		const target = document.querySelector<HTMLElement>(
			'[data-invalid] input:not(:disabled), [data-invalid] select, [data-invalid] textarea'
		);
		target?.focus();
		target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
	}

	async function focusReview() {
		await tick();
		const notice = document.getElementById('price-review');
		notice?.focus();
		notice?.scrollIntoView({ block: 'center', behavior: 'smooth' });
	}
</script>

<svelte:head>
	<title>Bring fionas to your event · {site.name}</title>
	<meta name="description" content="Tell us about your event and build your ice cream service." />
</svelte:head>

<main
	class="mx-auto w-full max-w-[640px] flex-1 px-6 pt-11 pb-[72px] max-[600px]:px-4 max-[600px]:pt-7"
>
	{#if !inquiryForm || !answers}
		<Card class="flex flex-col items-start gap-4">
			<h1 class="m-0 text-(--text-heading) [font:var(--type-h2)]">
				The request form isn't available right now
			</h1>
			<p class="m-0 text-(--text-body)">
				Please try again in a little while, or reach us directly and we'll get you sorted.
			</p>
			{#if frozen && replay}
				<form method="POST" class="flex flex-col gap-3">
					<p role="alert" class="m-0 text-sm">{formError}</p>
					<p class={hintText}>You can retry your original request with the same reviewed prices.</p>
					<input type="hidden" name="submissionToken" value={submissionToken} />
					<input type="hidden" name="priceRevision" value={priceRevision} />
					<input type="hidden" name="outcomeUnknown" value="true" />
					<input type="hidden" name="replayRequest" value={replay} />
					<Button type="submit">Try sending again</Button>
				</form>
			{/if}
			<div class="flex flex-wrap gap-3">
				<Button href={mailtoUrl}>Email us</Button>
				<Button href={instagramUrl} target="_blank" rel="noopener noreferrer" variant="secondary">
					Message on Instagram
				</Button>
			</div>
		</Card>
	{:else}
		<div class="mb-7 flex flex-col gap-2.5">
			<h1
				class="m-0 font-sans text-[34px] leading-[1.15] font-bold tracking-(--track-heading) text-balance text-(--text-heading) max-[600px]:text-[28px]"
			>
				bring fionas to your event
			</h1>
			<p class="m-0 text-(--text-body) [font:var(--type-body)]">
				Pick your flavors, tell us about your event, and check your estimate at the bottom. We'll
				follow up with a firm quote.
			</p>
		</div>

		{@const currentForm = inquiryForm}
		{@const currentAnswers = answers}
		<form
			method="POST"
			novalidate
			class="flex flex-col gap-7"
			use:enhance={({ cancel }) => {
				// One delivery at a time. Correctness doesn't depend on this: every delivery of this
				// submission carries the same key, so a duplicate would only replay the same receipt.
				if (phase === 'submitting') {
					cancel();
					return;
				}
				// Runs for every submit with the latest state (the form may have been refreshed since).
				// The gate: no complete service configuration, no request. The server checks again. A
				// retry after an unknown outcome is no new command: it resends `replay` as it is.
				attempted = true;
				formError = null;
				const command =
					outcomeUnknown && replay
						? ({ ok: true } as const)
						: prepareInquiry(inquiryForm!, answers!, { priceRevision });
				if (!command.ok) {
					cancel();
					if (command.reason === 'invalid') {
						errors = command.errors;
						focusFirstError();
					} else {
						formError =
							"We can't take requests online right now. Please try again later, or email us about your event.";
					}
					return;
				}
				errors = {};
				const previous = phase;
				phase = 'submitting';
				return async ({ result, update }) => {
					// Success redirects to /book/received; anything else stays on this form.
					await update({ reset: false });
					if (result.type === 'failure') {
						applyFailure(result.data as SubmissionFailure | undefined);
						if (review !== null) focusReview();
						else if (Object.keys(errors).length > 0) focusFirstError();
					} else if (result.type === 'error') {
						// The page couldn't hear back from its own server: as unknown as a lost response.
						phase = previous === 'ambiguous' || outcomeUnknown ? 'ambiguous' : 'failed';
						outcomeUnknown = phase === 'ambiguous';
						formError =
							"We couldn't confirm your request was received. Please try sending it again — if it did reach us, we won't record it twice.";
					}
				};
			}}
		>
			<input type="hidden" name="submissionToken" value={submissionToken} />
			<input type="hidden" name="priceRevision" value={priceRevision} />
			{#if frozen}
				<input type="hidden" name="outcomeUnknown" value="true" />
				{#if replay}
					<input type="hidden" name="replayRequest" value={replay} />
				{/if}
			{/if}

			<p role="status" class="sr-only">
				{submitting ? 'Sending your request…' : ''}
			</p>

			{#if review !== null}
				<Card
					id="price-review"
					tabindex={-1}
					role="alert"
					variant="flat"
					class="flex flex-col gap-2 border-rust-600 p-5 outline-none"
				>
					<h2 class="m-0 text-base leading-snug font-semibold text-(--text-heading)">
						{outcome === 'stale'
							? 'Our menu changed while you were filling this in'
							: 'Some of your choices need another look'}
					</h2>
					{#if review.removed > 0}
						<p class="m-0 text-(--text-body) [font:var(--type-body-sm)]">
							{review.removed === 1
								? "One of the options you chose isn't on our menu anymore, so we've removed it."
								: `${review.removed} of the options you chose aren't on our menu anymore, so we've removed them.`}
						</p>
					{/if}
					{#if review.unavailable.length > 0}
						<p class="m-0 text-(--text-body) [font:var(--type-body-sm)]">
							{listOf(review.unavailable)}
							{review.unavailable.length === 1 ? 'is' : 'are'} unavailable right now — check back later.
							We've unselected {review.unavailable.length === 1 ? 'it' : 'them'} so you can choose again.
						</p>
					{/if}
					<p class="m-0 text-(--text-body) [font:var(--type-body-sm)]">
						We haven't sent your request yet. We've updated the options and your estimate to what we
						offer now, and some choices or prices may have changed{review.fields.length > 0
							? ` — please look again at: ${review.fields.join(', ')}`
							: ''}. Check your choices and the estimate below, then send your request again.
					</p>
				</Card>
			{/if}

			<div
				class={cn(
					'flex flex-col gap-7 transition-opacity duration-(--dur-fast) ease-(--ease-out)',
					frozen && 'opacity-70'
				)}
				inert={frozen}
				data-frozen={frozen ? '' : undefined}
			>
				{#each currentForm.sections as section (section.key)}
					<!-- Only a section that may be left blank says so: the service section never can. -->
					<section class="flex flex-col gap-4" aria-labelledby="section-{section.key}">
						<div class={cn('flex flex-col gap-1', section.hideTitle && 'sr-only')}>
							<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
								<h2 id="section-{section.key}" class={cn(capsSm, 'm-0 text-(--text-heading)')}>
									{section.title}
								</h2>
								{#if isSkippable(section) && !section.hideTitle}
									<span
										class={cn(
											capsXs,
											'rounded-full border border-olive-300 px-2 py-0.5 text-[10px] text-(--text-muted)'
										)}
									>
										Optional
									</span>
								{/if}
							</div>
							{#if section.description}
								<p class={cn(hintText, 'm-0')}>
									{section.description}
								</p>
							{/if}
						</div>

						<div class="grid gap-x-3.5 gap-y-4 sm:grid-cols-2">
							{#each section.fields as field (field.key)}
								<InquiryField
									{field}
									bind:values={answers.values}
									error={errors[field.key]}
									preview={currentForm.pricingPreview}
									note={swirlNote(field, picksOf(field.key))}
									class={isCompact(field) ? undefined : 'sm:col-span-2'}
								/>
							{/each}
						</div>
					</section>
				{/each}

				<EstimatePanel form={currentForm} answers={currentAnswers} />
			</div>

			{#if formError}
				<div
					role="alert"
					class={cn(
						'flex flex-col items-start gap-3',
						frozen && 'rounded-[10px] border border-olive-300 bg-cream-100 p-4'
					)}
				>
					<p class="m-0 font-medium text-rust-600 [font:var(--type-body)]">{formError}</p>
					{#if frozen && replay}
						<p class={cn(hintText, 'm-0')}>
							Your answers are locked so we resend exactly what you sent before.
						</p>
					{/if}
					<div class="flex flex-wrap items-center gap-3">
						{#if outcome === 'key_reused' && restartToken}
							<Button
								type="submit"
								name="restartToken"
								value={restartToken}
								variant="secondary"
								disabled={submitting}
							>
								Send as a new request
							</Button>
						{/if}
						{#if frozen && restartToken && hydrated}
							<Button
								type="button"
								variant="secondary"
								disabled={submitting}
								onclick={changeAnswers}
							>
								Change my answers
							</Button>
						{/if}
						{#if outcome === 'key_reused' || frozen}
							<Button href={mailtoUrl} variant="ghost">Email us</Button>
						{/if}
					</div>
				</div>
			{/if}

			{#if restarted}
				<p class={cn(hintText, 'm-0')}>
					Your changes will go as a new request. If the earlier one did reach us, we'll spot the
					duplicate when we reply.
				</p>
			{/if}

			<div class="flex flex-col items-start gap-2.5">
				<!-- Frozen without the delivered request, nothing can safely be resent under this key. -->
				{#if !frozen || replay}
					<Button type="submit" size="lg" disabled={submitting}>
						{submitting ? 'Sending…' : frozen ? 'Try sending again' : 'Send booking request'}
					</Button>
				{/if}
				{#if missing}
					<p role="alert" class="m-0 font-sans text-[12.5px] leading-snug text-rust-600">
						{missing}
					</p>
				{/if}
			</div>
		</form>
	{/if}
</main>
