<script lang="ts">
	import { Badge, Card, capsSm, cn } from '@fionas/ui';
	import {
		completePricingInputs,
		computeAdvisoryEstimate,
		formatMoney,
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

	const inputs = $derived(completePricingInputs(form, answers));
	const complete = $derived(inputs !== null);
	// One server preview per distinct complete configuration (debounced), never per keystroke.
	const key = $derived(inputs ? JSON.stringify(inputs) : null);
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

<Card class="flex flex-col gap-3 px-6 py-[22px]" aria-labelledby="estimate-heading">
	<div class="flex items-center justify-between gap-3">
		<h2 id="estimate-heading" class={cn(capsSm, 'm-0 text-(--text-heading)')}>
			{complete ? 'Your estimate' : 'Your estimate so far'}
		</h2>
		<Badge tone="outline" size="sm">Estimate only</Badge>
	</div>

	<div aria-live="polite" class="flex flex-col gap-3">
		{#if estimate}
			<ul
				class={cn(
					'm-0 flex list-none flex-col gap-2.5 p-0 transition-opacity duration-(--dur-med) ease-(--ease-out)',
					stale && 'opacity-60'
				)}
			>
				{#each estimate.lines as line, i (i)}
					<li class="flex flex-col gap-0.5">
						<div class="flex items-baseline">
							<span class="text-[13px] leading-snug font-semibold text-(--text-body)">
								{line.description}
							</span>
							<span
								aria-hidden="true"
								class="mx-2 min-w-4 flex-1 border-b-2 border-dotted border-olive-300"
							></span>
							<span class="text-[13px] leading-snug font-semibold text-olive-900">
								{formatMoney(line.subtotal, line.currency)}
							</span>
						</div>
						{#if line.subDescription}
							<span class="text-[11.5px] leading-snug text-(--text-muted)">
								{line.subDescription}
							</span>
						{/if}
					</li>
				{/each}
			</ul>
			<div class="flex items-baseline justify-between gap-4 border-t-2 border-olive-700 pt-2.5">
				<span class={cn(capsSm, 'text-(--text-heading)')}
					>{estimate.guestCountIsMinimum ? 'Starting at' : 'Estimated total'}</span
				>
				<span class="text-xl leading-tight font-bold text-olive-900">
					{formatMoney(estimate.total, estimate.currency)}
				</span>
			</div>
		{:else if status === 'loading'}
			<p class="m-0 text-[12.5px] leading-snug text-(--text-muted)">Working out your estimate…</p>
		{:else}
			<p class="m-0 text-[12.5px] leading-snug text-(--text-muted)">
				Add your guest count and service length to start your estimate.
			</p>
		{/if}

		{#if status === 'rejected'}
			<p class="m-0 text-[12.5px] leading-snug font-medium text-rust-600">
				We couldn't price that combination. Please check your choices.
			</p>
		{:else if status === 'error' && !local}
			<p class="m-0 text-[12.5px] leading-snug font-medium text-rust-600">
				We couldn't update the estimate just now. You can still send your request.
			</p>
		{/if}
	</div>

	<p class="m-0 text-[11.5px] leading-[1.55] text-(--text-muted)">
		This is an early estimate, not a final quote. Travel within greater Fresno and Madera Ranchos is
		included in the base service — bookings farther out may carry an added travel fee, confirmed
		once we chat. No street address needed yet.
	</p>
</Card>
