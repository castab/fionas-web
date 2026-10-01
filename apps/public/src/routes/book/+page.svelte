<script lang="ts">
	import { enhance } from '$app/forms';
	import { tick, untrack } from 'svelte';
	import { Button, Card, capsXs, cn, hintText } from '@fionas/ui';
	import {
		emptyAnswers,
		instagramUrl,
		mailtoUrl,
		site,
		validateAnswers,
		type FieldErrors,
		type InquiryForm,
		type InquiryFormField,
		type InquiryAnswers
	} from '@fionas/shared';
	import EstimatePanel from '$lib/components/estimate-panel.svelte';
	import InquiryField from '$lib/components/inquiry-field.svelte';
	import type { SubmissionFailure } from '$lib/inquiry-submission.js';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

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
			catalogRevision: failed?.catalogRevision ?? inquiryForm?.catalogRevision ?? 0,
			restartToken: failed?.restartToken ?? null,
			review: reviewOf(failed)
		};
	});

	/** The form being answered: the loaded one, or the refreshed one after a catalog change. */
	let inquiryForm = $state.raw<InquiryForm | null>(initial.inquiryForm);
	let answers = $state<InquiryAnswers | null>(initial.answers);
	let errors = $state<FieldErrors>(initial.errors);
	let formError = $state<string | null>(initial.formError);
	let attempted = $state(Object.keys(initial.errors).length > 0 || initial.review !== null);
	let submitting = $state(false);

	/*
	 * The logical submission. Its token reaches the backend as `Idempotency-Key` and stays the same
	 * across double clicks and retries; only a reviewed catalog refresh (a new submission) replaces
	 * it. The revision pins the answers to the catalog they were given against.
	 */
	let submissionToken = $state(initial.submissionToken);
	let catalogRevision = $state(initial.catalogRevision);
	/** After IDEMPOTENCY_KEY_REUSED: the key for a deliberate "send as a new request". */
	let restartToken = $state<string | null>(initial.restartToken);
	/** After CATALOG_REVISION_STALE: labels of questions to look at again (empty: the estimate). */
	let review = $state<string[] | null>(initial.review);

	// Once the visitor has tried to submit, keep the messages in step with their edits.
	$effect(() => {
		if (attempted && inquiryForm && answers) errors = validateAnswers(inquiryForm, answers);
	});

	const hasPricing = $derived(
		!!inquiryForm?.sections.some((s) =>
			s.fields.some((f) => f.submissionPointer.startsWith('/pricingInputs/'))
		)
	);

	function reviewOf(failed: SubmissionFailure | null | undefined): string[] | null {
		return failed?.outcome === 'stale' && failed.refreshedForm ? (failed.reviewFields ?? []) : null;
	}

	function applyFailure(failed: SubmissionFailure | undefined) {
		if (failed?.refreshedForm) inquiryForm = failed.refreshedForm;
		if (failed?.answers) answers = failed.answers;
		if (failed?.submissionToken) submissionToken = failed.submissionToken;
		if (failed?.catalogRevision) catalogRevision = failed.catalogRevision;
		restartToken = failed?.restartToken ?? null;
		review = reviewOf(failed);
		formError = failed?.formError ?? null;
		errors =
			failed?.errors ?? (inquiryForm && answers ? validateAnswers(inquiryForm, answers) : {});
	}

	/** Short single-line answers sit two to a row; chip groups and notes take the full width. */
	const isCompact = (field: InquiryFormField) =>
		field.presentation.control === 'TEXT' ||
		field.presentation.control === 'DATE' ||
		field.input.type === 'STRING_CHOICE';

	async function focusFirstError() {
		await tick();
		const target = document.querySelector<HTMLElement>(
			'[data-invalid] input, [data-invalid] select, [data-invalid] textarea'
		);
		target?.focus();
		target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
	}

	async function focusReview() {
		await tick();
		const notice = document.getElementById('catalog-review');
		notice?.focus();
		notice?.scrollIntoView({ block: 'center', behavior: 'smooth' });
	}
</script>

<svelte:head>
	<title>Book · {site.name}</title>
	<meta name="description" content="Tell us about your event and build your ice cream service." />
</svelte:head>

<main
	class="mx-auto w-full max-w-[640px] flex-1 px-6 pt-11 pb-[72px] max-[600px]:px-4 max-[600px]:pt-7"
>
	<div class="mb-8 flex flex-col gap-3">
		<h1
			class="m-0 font-sans text-[34px] leading-[1.15] font-bold tracking-(--track-heading) text-balance text-(--text-heading) max-[600px]:text-[28px]"
		>
			Book the trailer
		</h1>
		<p class="m-0 text-(--text-body) [font:var(--type-body)]">
			Pick your flavors, tell us about your event, and check your estimate at the bottom — we'll
			follow up with a firm quote. Sending a request doesn't book anything or charge you.
		</p>
	</div>

	{#if !inquiryForm || !answers}
		<Card class="flex flex-col items-start gap-4">
			<h2 class="m-0 text-(--text-heading) [font:var(--type-h2)]">
				The booking form isn't available right now
			</h2>
			<p class="m-0 text-(--text-body)">
				Please try again in a little while, or reach us directly and we'll get you sorted.
			</p>
			<div class="flex flex-wrap gap-3">
				<Button href={mailtoUrl}>Email us</Button>
				<Button href={instagramUrl} target="_blank" rel="noopener noreferrer" variant="secondary">
					Message on Instagram
				</Button>
			</div>
		</Card>
	{:else}
		{@const currentForm = inquiryForm}
		<form
			method="POST"
			novalidate
			class="flex flex-col gap-7"
			use:enhance={({ cancel }) => {
				// Runs for every submit with the latest state (the form may have been refreshed since).
				attempted = true;
				errors = validateAnswers(inquiryForm!, answers!);
				formError = null;
				if (Object.keys(errors).length > 0) {
					cancel();
					focusFirstError();
					return;
				}
				submitting = true;
				return async ({ result, update }) => {
					// Success redirects to /book/received; anything else stays on this form.
					await update({ reset: false });
					submitting = false;
					if (result.type === 'failure') {
						applyFailure(result.data as SubmissionFailure | undefined);
						if (review !== null) focusReview();
						else if (Object.keys(errors).length > 0) focusFirstError();
					}
				};
			}}
		>
			<input type="hidden" name="submissionToken" value={submissionToken} />
			<input type="hidden" name="catalogRevision" value={catalogRevision} />

			{#if review !== null}
				<Card
					id="catalog-review"
					tabindex={-1}
					role="alert"
					variant="flat"
					class="flex flex-col gap-2 border-rust-600 p-5 outline-none"
				>
					<h2 class="m-0 text-base leading-snug font-semibold text-(--text-heading)">
						Our menu changed while you were filling this in
					</h2>
					<p class="m-0 text-(--text-body) [font:var(--type-body-sm)]">
						We haven't sent your request yet. We've updated the options and your estimate to what we
						offer now{review.length > 0 ? ` — please look again at: ${review.join(', ')}` : ''}.
						Check your choices and the estimate below, then send your request again.
					</p>
				</Card>
			{/if}

			{#each currentForm.sections as section (section.key)}
				<section class="flex flex-col gap-3.5" aria-labelledby="section-{section.key}">
					<div class="flex flex-col gap-1">
						<h2 id="section-{section.key}" class={cn(capsXs, 'm-0 text-olive-700')}>
							{section.title}
						</h2>
						{#if section.description}
							<p class={cn(hintText, 'm-0')}>
								{section.description}
							</p>
						{/if}
					</div>

					<div class="grid gap-x-4 gap-y-4 sm:grid-cols-2">
						{#each section.fields as field (field.key)}
							<InquiryField
								{field}
								bind:values={answers.values}
								error={errors[field.key]}
								preview={currentForm.pricingPreview}
								class={isCompact(field) ? undefined : 'sm:col-span-2'}
							/>
						{/each}
					</div>
				</section>
			{/each}

			{#if hasPricing}
				<EstimatePanel form={currentForm} {answers} />
			{/if}

			{#if formError}
				<div role="alert" class="flex flex-col items-start gap-3">
					<p class="m-0 font-medium text-rust-600 [font:var(--type-body)]">{formError}</p>
					{#if restartToken}
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
				</div>
			{/if}

			<div class="flex flex-wrap items-center justify-between gap-4">
				<p class={cn(hintText, 'm-0 max-w-[340px]')}>
					We'll only use your details to reply to this request.
				</p>
				<Button type="submit" size="lg" disabled={submitting}>
					{submitting ? 'Sending…' : 'Send booking request'}
				</Button>
			</div>
		</form>
	{/if}
</main>
