<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { tick, untrack } from 'svelte';
	import { Button, Card, capsXs, cn, hintText } from '@fionas/ui';
	import {
		emptyAnswers,
		instagramUrl,
		mailtoUrl,
		site,
		validateAnswers,
		type FieldErrors,
		type InquiryFormField,
		type InquiryAnswers
	} from '@fionas/shared';
	import EstimatePanel from '$lib/components/estimate-panel.svelte';
	import InquiryField from '$lib/components/inquiry-field.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Answers survive a failed submit: the server echoes them back for the no-JS path. Only the
	// initial values matter here; after hydration the client owns this state.
	const initial = untrack(() => ({
		answers: data.form
			? ((form && 'answers' in form ? form.answers : undefined) ?? emptyAnswers(data.form))
			: null,
		errors: (form && 'errors' in form ? form.errors : undefined) ?? {},
		formError: (form && 'formError' in form ? form.formError : undefined) ?? null
	}));

	let answers = $state<InquiryAnswers | null>(initial.answers);
	let errors = $state<FieldErrors>(initial.errors);
	let formError = $state<string | null>(initial.formError);
	let attempted = $state(Object.keys(initial.errors).length > 0);
	let submitting = $state(false);

	// Once the visitor has tried to submit, keep the messages in step with their edits.
	$effect(() => {
		if (attempted && data.form && answers) errors = validateAnswers(data.form, answers);
	});

	const hasPricing = $derived(
		!!data.form?.sections.some((s) =>
			s.fields.some((f) => f.submissionPointer.startsWith('/pricingInputs/'))
		)
	);

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

	{#if !data.form}
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
	{:else if form && 'success' in form && form.success}
		<Card class="flex flex-col items-start gap-4" role="status">
			<h2 class="m-0 text-(--text-heading) [font:var(--type-h2)]">
				Thanks — we got your request! 🍦
			</h2>
			<p class="m-0 text-(--text-body)">
				We'll be in touch at the email you gave us to talk through your event. Nothing is booked or
				charged yet.
			</p>
			<Button href={resolve('/')} variant="secondary">Back to home</Button>
		</Card>
	{:else if answers}
		{@const inquiryForm = data.form}
		<form
			method="POST"
			novalidate
			class="flex flex-col gap-7"
			use:enhance={({ cancel }) => {
				attempted = true;
				errors = validateAnswers(inquiryForm, answers!);
				formError = null;
				if (Object.keys(errors).length > 0) {
					cancel();
					focusFirstError();
					return;
				}
				submitting = true;
				return async ({ result, update }) => {
					await update({ reset: false });
					submitting = false;
					if (result.type === 'failure') {
						const failed = result.data as { errors?: FieldErrors; formError?: string } | undefined;
						errors = failed?.errors ?? {};
						formError = failed?.formError ?? null;
						if (Object.keys(errors).length > 0) focusFirstError();
					}
				};
			}}
		>
			{#each inquiryForm.sections as section (section.key)}
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
								preview={inquiryForm.pricingPreview}
								class={isCompact(field) ? undefined : 'sm:col-span-2'}
							/>
						{/each}
					</div>
				</section>
			{/each}

			{#if hasPricing}
				<EstimatePanel form={inquiryForm} {answers} />
			{/if}

			{#if formError}
				<p role="alert" class="m-0 font-medium text-rust-600 [font:var(--type-body)]">
					{formError}
				</p>
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
