<script lang="ts">
	import { untrack } from 'svelte';
	import { Button, Card, capsSm, cn, hintText } from '@fionas/ui';
	import { mailtoUrl, site } from '@fionas/shared';
	import type { EmbeddedLaunch } from '$lib/payments/controller.js';
	import {
		startEmbeddedCheckout,
		stripeEmbeddedCheckout,
		type EmbeddedFactory,
		type EmbeddedFailure
	} from '$lib/payments/embedded.js';
	import { formatCents } from '$lib/payments/money.js';

	/**
	 * Stripe's embedded payment form for one authorized launch, inside Fiona's page. Stripe owns
	 * every card field (in its iframe); this component only mounts it, reports completion and
	 * cleans up. It never creates a Session, picks an amount or decides that money moved: the
	 * controller owns authorization and recovery, commerce owns the outcome.
	 */
	let {
		launch,
		publishableKey,
		factory = stripeEmbeddedCheckout,
		oncomplete,
		onclose
	}: {
		launch: EmbeddedLaunch;
		/** The configured Stripe publishable key, already validated; null when unusable. */
		publishableKey: string | null;
		/** Stripe.js boundary, injectable for tests. Defaults to official Stripe.js. */
		factory?: EmbeddedFactory;
		oncomplete: (launchId: number) => void;
		onclose: () => void;
	} = $props();

	let container = $state<HTMLElement>();
	let heading = $state<HTMLElement>();
	let status = $state<'loading' | 'ready' | 'failed'>('loading');
	let failure = $state<EmbeddedFailure | null>(null);
	/** A deliberate "Try again" remounts the same launch (same Session), never a new one. */
	let attempt = $state(0);
	const launchId = $derived(launch.id);

	// One Stripe instance per launch and attempt. Cleanup runs on close, completion, replacement,
	// revocation and navigation alike; a late initialization after cleanup is destroyed unmounted.
	$effect(() => {
		const element = container;
		const id = launchId;
		void attempt;
		if (!element) return;
		return untrack(() => {
			const current = launch;
			status = 'loading';
			failure = null;
			return startEmbeddedCheckout({
				factory,
				publishableKey,
				element,
				clientSecret: () => current.clientSecret(),
				onComplete: () => oncomplete(id),
				onReady: () => (status = 'ready'),
				onFailure: (kind) => {
					failure = kind;
					status = 'failed';
				}
			});
		});
	});

	// Opening the form moves focus to its heading so keyboard and screen-reader users land here.
	$effect(() => {
		void launchId;
		untrack(() => heading?.focus());
	});

	const body = 'm-0 text-(--text-body) [font:var(--type-body-sm)]';
	const description = $derived(
		launch.purpose === 'DEPOSIT'
			? `Deposit for your ${site.name} booking`
			: 'Payment toward your Invoice'
	);
</script>

<Card
	class="flex flex-col gap-5 px-[26px] py-6 max-[600px]:px-4"
	data-testid="embedded-checkout"
	data-launch={launch.id}
>
	<section aria-labelledby="embedded-checkout-title" class="flex flex-col gap-5">
		<div class="flex flex-col gap-1">
			<p class={cn(capsSm, 'm-0 text-(--text-muted)')}>Secure payment</p>
			<h2
				id="embedded-checkout-title"
				bind:this={heading}
				tabindex="-1"
				class="m-0 font-sans text-lg leading-[1.35] font-bold text-(--text-heading) focus:outline-none"
			>
				Complete your payment
			</h2>
			<p class={body} data-testid="embedded-description">{description}</p>
		</div>

		<div class="flex items-baseline justify-between gap-3 rounded-input bg-cream-200 px-4 py-3.5">
			<span class={cn(capsSm, 'text-(--text-muted)')}
				>{launch.purpose === 'DEPOSIT' ? 'Deposit' : 'Amount'}</span
			>
			<span
				class="font-sans text-[22px] leading-[1.25] font-bold wrap-anywhere text-(--text-heading)"
				data-testid="embedded-amount">{formatCents(launch.amountCents)}</span
			>
		</div>

		<div class="relative">
			{#if status === 'loading'}
				<div
					role="status"
					class="absolute inset-0 flex items-center justify-center rounded-[10px] bg-cream-200/70"
					data-testid="embedded-loading"
				>
					<p class={cn(body, 'text-(--text-muted)')}>Loading the secure payment form…</p>
				</div>
			{/if}
			<!-- Stripe's iframe is mounted here: no Fiona's input ever touches card details. -->
			<div
				bind:this={container}
				class={cn(
					'min-w-0 rounded-[10px] transition-[min-height] duration-(--dur-fast) ease-out',
					status === 'loading' && 'min-h-[420px]',
					status === 'failed' && 'hidden'
				)}
				data-testid="embedded-mount"
			></div>
			{#if status === 'failed'}
				<div
					role="alert"
					class="flex flex-col items-start gap-3 rounded-[10px] border-2 border-olive-700 bg-olive-100/50 px-5 py-4"
					data-testid="embedded-error"
				>
					<p class="m-0 font-sans text-[15px] leading-snug font-semibold text-(--text-heading)">
						We couldn't load the secure payment form
					</p>
					{#if failure === 'configuration'}
						<p class={body}>
							Online card entry isn't available on this page right now. Your payment hasn't been
							started again or changed. Please contact us at
							<!-- eslint-disable svelte/no-navigation-without-resolve -- external mailto link -->
							<a
								href={mailtoUrl}
								class="text-olive-800 underline underline-offset-2 hover:text-olive-900"
								>{site.email}</a
							>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
							and we'll help you finish it.
						</p>
					{:else}
						<p class={body}>
							Check your connection, or pause any content blocker for this page, then try again.
							Trying again opens the same payment, never a new one.
						</p>
						<Button
							variant="secondary"
							size="sm"
							class="min-h-11"
							onclick={() => attempt++}
							data-testid="embedded-retry">Try again</Button
						>
					{/if}
				</div>
			{/if}
		</div>

		<p class={cn(hintText, 'm-0')}>
			Secure payment powered by Stripe. Your card details go directly to Stripe; {site.name} never sees
			them.
		</p>
	</section>

	<div class="border-t border-(--border-soft) pt-4">
		<Button
			variant="ghost"
			size="sm"
			class="min-h-11"
			onclick={onclose}
			data-testid="embedded-close">Back to booking overview</Button
		>
	</div>
</Card>
