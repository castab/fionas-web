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

<!-- Rendered inside the Right now action row: the alert takes a full line, the form one button. -->
{#if message}
	<div role="alert" class="flex basis-full flex-col items-start gap-3">
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
		class="flex flex-[1.4_1_150px]"
		data-testid="fulfillment-form"
	>
		<Button
			type="submit"
			class="min-h-12 w-full"
			title={serve
				? 'Use this after the event has been fulfilled. The event date never changes this status automatically.'
				: undefined}
			disabled={pending || blocked}
		>
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
