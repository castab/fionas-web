<script lang="ts">
	import { focusRing } from '@fionas/ui';
	import { hint } from './styles.js';
	import type { CurrentStaffRequest } from '$lib/request-contract.js';
	import { serviceCommitment } from '$lib/service-plan.js';
	import { receivedTimeLabel } from '$lib/payments.js';

	let {
		request,
		clearPlan = $bindable(false),
		dropped = []
	}: {
		request: CurrentStaffRequest;
		/** The deliberate choice to remove the commitment; never implied by a blank description. */
		clearPlan: boolean;
		/** Notes on lines this draft removes; they leave the plan with their lines. */
		dropped?: { lineItemId: string; description: string; note: string }[];
	} = $props();
	const commitment = $derived(serviceCommitment(request));
</script>

<div class="flex flex-col gap-2.5" data-testid="service-plan-controls">
	{#if commitment.state === 'NEVER'}
		<p class={hint} data-testid="plan-state">
			No service plan has been approved for this booking. Add a description to create one, or leave
			it empty to keep it that way.
		</p>
	{:else if commitment.state === 'CLEARED'}
		<p class={hint} data-testid="plan-state">
			The service plan was removed ({receivedTimeLabel(commitment.plan.approvedAt)}). Add a
			description to approve a new one.
		</p>
	{:else}
		<p class={hint} data-testid="plan-state">
			Plan revision {commitment.plan.revision}, approved {receivedTimeLabel(
				commitment.plan.approvedAt
			)}. Change anything below to replace it, or leave it alone to keep it as approved.
		</p>
	{/if}
	{#if dropped.length}
		<div role="note" class="text-[12.5px] leading-[1.55]" data-testid="dropped-notes">
			<p class="m-0 font-semibold">These service notes leave with their removed lines</p>
			<ul class="m-0 mt-1 pl-5">
				{#each dropped as note (note.lineItemId)}
					<li class="wrap-anywhere">{note.description}: {note.note}</li>
				{/each}
			</ul>
			<p class={`${hint} mt-1`}>The service plan is replaced without them; check the preview.</p>
		</div>
	{/if}
	{#if commitment.state === 'APPROVED'}
		<div class="flex items-start gap-2 text-sm">
			<input
				id="clear-plan"
				type="checkbox"
				name="clearPlan"
				aria-describedby="clear-plan-help"
				bind:checked={clearPlan}
				class={`mt-1 accent-olive-700 ${focusRing}`}
			/>
			<div>
				<label for="clear-plan" class="block font-semibold">Remove the service plan</label>
				<p id="clear-plan-help" class="m-0 text-xs text-(--text-muted)">
					Removes the approved description, guests, selections and line notes from this booking. The
					history keeps it, and a new plan can be approved later. Changes to the plan below are
					ignored while this is on.
				</p>
			</div>
		</div>
	{/if}
</div>
