<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { Button, Card, focusRing } from '@fionas/ui';
	import type { CurrentStaffRequest } from '$lib/request-contract.js';
	import { canDeclineInquiry } from '$lib/request-workspace.js';
	import {
		DECLINE_REASON_MAX,
		declineErrorMessage,
		declineReason,
		declineReasonMessage,
		declineReasonProblem,
		type DeclineFormValues
	} from '$lib/decline.js';
	import { eventDateLabel, eventTypeLabel } from '$lib/presentation.js';
	import { workspaceAction, type RequestListQuery } from '$lib/request-list.js';

	let {
		request,
		permissions,
		route,
		returnContext = null,
		error,
		fieldError = false,
		reviewRequired = false,
		values,
		focusOnOpen = false,
		pending = $bindable(false),
		onReviewRequired
	}: {
		request: CurrentStaffRequest;
		permissions: string[];
		route: string;
		/** The Requests index view this workspace was opened from; kept through every action. */
		returnContext?: RequestListQuery | null;
		error?: string;
		/** The server refused the reason itself (correctable), not the request state. */
		fieldError?: boolean;
		reviewRequired?: boolean;
		values?: DeclineFormValues;
		/** Opened deliberately from Decline: move focus to the reason. */
		focusOnOpen?: boolean;
		pending?: boolean;
		onReviewRequired: () => void;
	} = $props();
	let submitting = $state(false);
	let hydrated = $state(false);
	onMount(() => {
		hydrated = true;
	});
	let unexpectedError = $state<string | null>(null);
	let localError = $state<string | null>(null);
	let reason = $derived(values?.reason ?? '');
	let reasonElement = $state<HTMLTextAreaElement>();
	const eligible = $derived(canDeclineInquiry(request, permissions));
	// A native failed POST may render newer state than the version this decline reviewed.
	const changed = $derived(
		!!values && values.expectedDocumentVersion !== String(request.financial.version)
	);
	const blocked = $derived(reviewRequired || !!unexpectedError || changed);
	// Editing the reason clears a correctable server message; review states never clear locally.
	let corrected = $state(false);
	const serverError = $derived(fieldError && corrected ? undefined : error);
	const message = $derived(
		unexpectedError ?? (changed ? declineErrorMessage(409) : (localError ?? serverError))
	);
	const reasonInvalid = $derived(!blocked && (!!localError || (fieldError && !corrected)));
	const length = $derived(declineReason(reason).length);
	const submit: SubmitFunction = ({ cancel }) => {
		if (pending || blocked) {
			cancel();
			return;
		}
		const problem = declineReasonProblem(reason);
		if (problem) {
			cancel();
			localError = declineReasonMessage(problem);
			reasonElement?.focus();
			return;
		}
		localError = null;
		corrected = false;
		submitting = true;
		pending = true;
		return async ({ result, update }) => {
			try {
				if (result.type === 'error') {
					// The POST may have committed: never offer a second attempt from this state.
					unexpectedError = declineErrorMessage(503, true);
					onReviewRequired();
				} else {
					await update({ reset: false, invalidateAll: false });
				}
				if (result.type === 'error' || result.type === 'failure')
					document.getElementById('decline-error')?.focus();
			} finally {
				submitting = false;
				pending = false;
			}
		};
	};
	const caps =
		'm-0 font-sans text-[11px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-heading) uppercase';
</script>

<Card
	variant="flat"
	id="decline-request"
	role="region"
	aria-labelledby="decline-request-title"
	class="flex flex-col gap-4 border-2 border-rust-600 p-[18px] sm:p-5"
>
	<div class="flex flex-col gap-1.5">
		<h2 id="decline-request-title" class={caps}>Decline this request?</h2>
		<p class="m-0 text-[15px] leading-[1.4] font-bold wrap-anywhere text-(--text-heading)">
			{request.inquiry.name} · {eventDateLabel(request.inquiry.eventDate)} · {eventTypeLabel(
				request.inquiry.eventType
			)}
		</p>
		<p class="m-0 text-xs leading-[1.55] text-(--text-muted)">
			This removes the request from your active work and the dashboard. The inquiry and its original
			Estimate v{request.financial.version} will remain on file. The customer will not be notified automatically.
		</p>
		<p class="m-0 text-xs leading-[1.55] font-semibold text-(--text-body)">
			Declining is final: the staff console can’t reopen a declined request.
		</p>
	</div>
	{#if message}
		<div role="alert" class="flex flex-col items-start gap-3">
			<p id="decline-error" tabindex="-1" class="m-0 text-sm text-rust-600">{message}</p>
			{#if blocked}<Button href={route} data-sveltekit-reload variant="secondary" size="sm"
					>Reload to review</Button
				>{/if}
		</div>
	{/if}
	{#if eligible || values}
		<form
			method="POST"
			action={workspaceAction(returnContext, 'declineInquiry')}
			novalidate
			use:enhance={submit}
			aria-busy={submitting}
			class="flex flex-col gap-4"
			data-testid="decline-form"
		>
			<input
				type="hidden"
				name="expectedDocumentVersion"
				value={values?.expectedDocumentVersion ?? request.financial.version}
			/>
			<div class="flex flex-col gap-1.5">
				<label for="decline-reason" class={caps}>Reason for declining</label>
				<!-- Focus follows an explicit Decline click; SvelteKit honors autofocus after navigation. -->
				<!-- svelte-ignore a11y_autofocus -->
				<textarea
					id="decline-reason"
					name="reason"
					rows="3"
					required
					maxlength={DECLINE_REASON_MAX}
					autofocus={focusOnOpen && !message}
					bind:this={reasonElement}
					bind:value={reason}
					disabled={pending || blocked}
					aria-invalid={reasonInvalid ? 'true' : undefined}
					aria-describedby={reasonInvalid
						? 'decline-reason-help decline-error'
						: 'decline-reason-help'}
					oninput={() => {
						localError = null;
						corrected = true;
					}}
					class={`min-h-24 w-full min-w-0 resize-y rounded-input border border-(--border-soft) bg-(--surface-card) px-3 py-2.5 text-sm leading-[1.55] aria-invalid:border-rust-600 ${focusRing}`}
				></textarea>
				<p
					id="decline-reason-help"
					class="m-0 flex justify-between gap-3 text-xs text-(--text-muted)"
				>
					<span>Internal staff note. Never sent to the customer.</span>
					<!-- A live count needs JavaScript; without it a static count would mislead. -->
					{#if hydrated}<span aria-hidden="true" class="whitespace-nowrap"
							>{length}/{DECLINE_REASON_MAX}</span
						>{/if}
				</p>
			</div>
			<div class="flex flex-wrap gap-2.5">
				<Button
					type="submit"
					disabled={pending || blocked}
					class="min-h-12 flex-[1.4_1_150px] bg-rust-600 text-cream-100 not-disabled:hover:bg-rust-600/90"
					>{submitting ? 'Declining…' : 'Decline request'}</Button
				>
				<!-- Unavailable mid-submit; once blocked, Reload to review is the only way out. -->
				{#if !blocked}<Button
						href={route}
						variant="secondary"
						disabled={pending}
						class="min-h-12 flex-[1_1_120px] aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
						>Keep request</Button
					>{/if}
			</div>
		</form>
	{/if}
</Card>
