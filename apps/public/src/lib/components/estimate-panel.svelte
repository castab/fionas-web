<script lang="ts">
	import { Card, capsSm, cn } from '@fionas/ui';
	import {
		buildPricingInputs,
		computeAdvisoryEstimate,
		formatMoney,
		isEstimateReady,
		type EstimatePreview,
		type InquiryAnswers,
		type InquiryForm
	} from '@fionas/shared';

	/**
	 * Price estimate. Figures appear instantly from the form's `pricingPreview` (advisory browser
	 * arithmetic) as soon as guests and service length are known, growing as choices are made. Once
	 * every question is answered, the server's POST /estimate-preview result replaces them as the
	 * authoritative answer. If the server can't be reached the instant figures stay.
	 */
	let { form, answers }: { form: InquiryForm; answers: InquiryAnswers } = $props();

	const DEBOUNCE_MS = 300;

	let server = $state<{ key: string; estimate: EstimatePreview } | null>(null);
	let status = $state<'idle' | 'loading' | 'error' | 'rejected'>('idle');

	const complete = $derived(isEstimateReady(form, answers));
	const key = $derived(complete ? JSON.stringify(buildPricingInputs(form, answers)) : null);
	const local = $derived(computeAdvisoryEstimate(form, answers));

	const serverCurrent = $derived(server && server.key === key ? server.estimate : null);
	const estimate = $derived(
		status === 'rejected' ? null : (serverCurrent ?? local ?? server?.estimate ?? null)
	);
	// Only older figures (no instant estimate available) are worth dimming while we wait.
	const stale = $derived(estimate !== null && !serverCurrent && !local);

	$effect(() => {
		if (key === null) {
			server = null;
			status = 'idle';
			return;
		}

		status = 'loading';
		const controller = new AbortController();
		const timer = setTimeout(async () => {
			try {
				const response = await fetch('/book/estimate', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: key,
					signal: controller.signal
				});
				if (!response.ok) throw new Error(String(response.status));
				server = { key, estimate: (await response.json()) as EstimatePreview };
				status = 'idle';
			} catch (e) {
				if (controller.signal.aborted) return;
				// The server refused this selection (4xx): never show figures for it. Outages are not refusals.
				status = e instanceof Error && /^4\d\d$/.test(e.message) ? 'rejected' : 'error';
			}
		}, DEBOUNCE_MS);

		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	});
</script>

<Card class="flex flex-col gap-4 p-5" aria-labelledby="estimate-heading">
	<div class="flex items-center justify-between gap-3">
		<h2 id="estimate-heading" class={cn(capsSm, 'm-0 text-(--text-heading)')}>
			{complete ? 'Your estimate' : 'Your estimate so far'}
		</h2>
		<span
			class={cn(
				capsSm,
				'rounded-full border border-olive-300 px-2.5 py-1 text-[10px] text-olive-700'
			)}
		>
			Estimate only
		</span>
	</div>

	<div aria-live="polite" class="flex flex-col gap-4">
		{#if estimate}
			<ul
				class={cn(
					'm-0 flex list-none flex-col gap-3 p-0 transition-opacity duration-(--dur-med) ease-(--ease-out)',
					stale && 'opacity-60'
				)}
			>
				{#each estimate.lines as line, i (i)}
					<li class="flex flex-col gap-0.5">
						<div class="flex items-baseline gap-2">
							<span class="font-semibold text-(--text-heading) [font:var(--type-body)]">
								{line.description}
							</span>
							<span
								aria-hidden="true"
								class="min-w-4 flex-1 -translate-y-0.5 border-b-2 border-dotted border-olive-300"
							></span>
							<span class="font-semibold text-(--text-heading) [font:var(--type-body)]">
								{formatMoney(line.subtotal, line.currency)}
							</span>
						</div>
						{#if line.subDescription}
							<span class="text-(--text-muted) [font:var(--type-body-sm)]"
								>{line.subDescription}</span
							>
						{/if}
					</li>
				{/each}
			</ul>
			<div
				class="flex items-baseline justify-between gap-4 border-t-2 border-olive-700 pt-3 text-(--text-heading)"
			>
				<span class={capsSm}
					>{estimate.guestCountIsMinimum ? 'Starting at' : 'Estimated total'}</span
				>
				<span class="[font:var(--type-h2)]">{formatMoney(estimate.total, estimate.currency)}</span>
			</div>
		{:else if status === 'loading'}
			<p class="m-0 text-(--text-muted) [font:var(--type-body-sm)]">Working out your estimate…</p>
		{:else}
			<p class="m-0 text-(--text-muted) [font:var(--type-body-sm)]">
				Add your guest count and service length to start your estimate.
			</p>
		{/if}

		{#if status === 'rejected'}
			<p class="m-0 font-medium text-rust-600 [font:var(--type-body-sm)]">
				We couldn't price that combination. Please check your choices.
			</p>
		{:else if status === 'error' && !local}
			<p class="m-0 font-medium text-rust-600 [font:var(--type-body-sm)]">
				We couldn't update the estimate just now. You can still send your inquiry.
			</p>
		{/if}
	</div>

	<p class="m-0 text-(--text-muted) [font:var(--type-body-sm)]">
		This is an early estimate, not a final quote. We'll follow up to confirm the details.
	</p>
</Card>
