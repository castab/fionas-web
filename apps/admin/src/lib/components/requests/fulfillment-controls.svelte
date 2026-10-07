<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { Button } from '@fionas/ui';
	import type { CurrentStaffRequest } from '$lib/request-contract.js';
	import {
		canMarkServed,
		canCloseInquiry,
		fulfillmentErrorMessage
	} from '$lib/request-workspace.js';
	let {
		request,
		permissions,
		route,
		error,
		reviewRequired = false,
		pending = $bindable(false),
		onReviewRequired
	}: {
		request: CurrentStaffRequest;
		permissions: string[];
		route: string;
		error?: string;
		reviewRequired?: boolean;
		pending?: boolean;
		onReviewRequired: () => void;
	} = $props();
	let submitting = $state(false);
	let unexpectedError = $state<string | null>(null);
	const serve = $derived(canMarkServed(request, permissions));
	const close = $derived(canCloseInquiry(request, permissions));
	const message = $derived(unexpectedError ?? error);
	const blocked = $derived(reviewRequired || !!unexpectedError);
	const submit: SubmitFunction = ({ cancel }) => {
		if (pending || blocked) {
			cancel();
			return;
		}
		const action = serve ? 'markServed' : 'closeInquiry';
		submitting = true;
		pending = true;
		return async ({ result, update }) => {
			try {
				if (result.type === 'error') {
					unexpectedError = fulfillmentErrorMessage(503, action, true);
					onReviewRequired();
				} else {
					await update({ reset: false, invalidateAll: false });
				}
				if (result.type === 'error' || result.type === 'failure')
					document.getElementById('fulfillment-error')?.focus();
			} finally {
				submitting = false;
				pending = false;
			}
		};
	};
</script>

{#if message}
	<div role="alert" class="flex flex-col items-start gap-3">
		<p id="fulfillment-error" tabindex="-1" class="m-0 text-sm text-rust-600">{message}</p>
		<Button href={route} data-sveltekit-reload variant="secondary" size="sm"
			>Reload to review</Button
		>
	</div>
{/if}
{#if serve || close}
	<form
		method="POST"
		action={serve ? '?/markServed' : '?/closeInquiry'}
		use:enhance={submit}
		aria-busy={submitting}
		class="flex flex-col gap-3 border-t border-(--border-soft) pt-3"
		data-testid="fulfillment-form"
	>
		<p class="m-0 text-xs text-(--text-muted)">
			{serve
				? 'Use this after the event has been fulfilled. The scheduled event date does not change this status automatically.'
				: 'Close this event to complete the request.'}
		</p>
		<Button type="submit" variant="secondary" class="w-full" disabled={pending || blocked}>
			{submitting
				? serve
					? 'Marking served…'
					: 'Closing…'
				: serve
					? 'Mark event served'
					: 'Close event'}
		</Button>
	</form>
{/if}
