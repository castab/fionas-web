<script lang="ts">
	import { untrack } from 'svelte';
	import { Badge, Button, Card, capsSm, cn, hintText } from '@fionas/ui';
	import type { OnPageCheckoutLaunch } from '$lib/payments/controller.js';
	import { startCheckoutElements, type ElementsView } from '$lib/payments/elements.js';
	import { formatCents } from '$lib/payments/money.js';

	let {
		launch,
		publishableKey,
		summaryFresh,
		refreshing,
		onprepare,
		onconfirm,
		onretryable,
		onpending,
		onclose,
		onrefresh,
		onrecover
	}: {
		launch: OnPageCheckoutLaunch;
		publishableKey: string | null;
		summaryFresh: boolean;
		refreshing: boolean;
		onprepare: (id: number) => Promise<boolean>;
		onconfirm: (id: number) => boolean;
		onretryable: (id: number) => void;
		onpending: (id: number) => void;
		onclose: (id: number) => void;
		onrefresh: () => void;
		onrecover: (id: number) => void;
	} = $props();

	let heading = $state<HTMLHeadingElement>();
	let contactMount = $state<HTMLElement>();
	let paymentMount = $state<HTMLElement>();
	let view = $state.raw<ElementsView>({ kind: 'loading' });
	let confirm: (() => Promise<void>) | undefined;
	const submitting = $derived(view.kind === 'ready' && view.submitting);
	const body = 'm-0 text-(--text-body) [font:var(--type-body-sm)]';

	$effect(() => {
		heading?.focus();
	});

	$effect(() => {
		if (!contactMount || !paymentMount) return;
		const contact = contactMount;
		const payment = paymentMount;
		// The page keys this component by launch ID. Summary reads may update the parent
		// during preflight, but the mounted fields must stay intact for the same launch.
		const form = untrack(() => {
			const current = launch;
			return startCheckoutElements({
				launch: current,
				publishableKey,
				contactMount: contact,
				paymentMount: payment,
				onChange: (next) => (view = next),
				prepareConfirmation: () => onprepare(current.id),
				beginConfirmation: () => onconfirm(current.id),
				onRetryable: () => onretryable(current.id),
				onPending: () => onpending(current.id)
			});
		});
		confirm = form.confirm;
		return form.stop;
	});
</script>

<Card class="flex flex-col gap-5 px-[26px] py-6 max-[600px]:px-5" data-testid="elements-checkout">
	<section aria-labelledby="elements-checkout-title" class="flex min-w-0 flex-col gap-5">
		<header class="flex flex-col items-start gap-2">
			<Badge tone="olive">Secure payment</Badge>
			<h2
				id="elements-checkout-title"
				bind:this={heading}
				tabindex="-1"
				class="m-0 font-sans text-[22px] leading-tight font-bold text-(--text-heading) focus:outline-none"
			>
				Complete your payment
			</h2>
			<p class={body}>
				{launch.purpose === 'DEPOSIT' ? 'Deposit for your booking' : 'Payment toward your Invoice'}
			</p>
		</header>

		{#if view.kind === 'ready'}
			<dl
				class="m-0 flex items-baseline justify-between gap-4 rounded-input bg-cream-200 px-4 py-3"
			>
				<dt class={cn(capsSm, 'text-(--text-muted)')}>Payment amount</dt>
				<dd
					class="m-0 font-sans text-[22px] leading-tight font-bold text-(--text-heading)"
					data-testid="elements-amount"
				>
					{formatCents(view.amount)}
				</dd>
			</dl>
		{:else if view.kind === 'loading'}
			<p role="status" class={body}>Loading the secure payment form…</p>
		{:else}
			<div class="flex flex-col items-start gap-3">
				<p role="alert" class={body}>
					{view.reason === 'amount'
						? "We couldn't verify the amount for this payment. Check the previous payment to review its current status."
						: view.reason === 'expired'
							? 'This payment form is no longer open. Check the previous payment for an update.'
							: "We couldn't load the secure payment form. Check your connection and try the same payment again."}
				</p>
				<Button variant="secondary" class="min-h-11" onclick={() => onrecover(launch.id)}
					>Check previous payment</Button
				>
			</div>
		{/if}

		<form
			onsubmit={(event) => {
				event.preventDefault();
				if (summaryFresh && !refreshing) void confirm?.();
			}}
			aria-busy={submitting}
			class={cn(
				'flex min-w-0 flex-col gap-4',
				view.kind === 'loading' && 'invisible',
				view.kind === 'unavailable' && 'hidden'
			)}
			inert={view.kind !== 'ready'}
		>
			<!-- Keep the mount points in the document while Stripe initializes its frames. -->
			<div class="min-w-0" bind:this={contactMount} data-testid="elements-contact"></div>
			<div class="flex min-w-0 flex-col gap-2">
				<h3 class={cn(capsSm, 'm-0 text-(--text-heading)')}>Payment details</h3>
				<div class="min-w-0" bind:this={paymentMount} data-testid="elements-payment"></div>
			</div>
			{#if view.kind === 'ready'}
				{#if view.error}
					<p class="m-0 text-rust-600 [font:var(--type-body-sm)]" role="alert">
						{view.error === 'declined'
							? 'Your payment was declined. Check your details or try another card.'
							: 'Check the details in the payment form and try again.'}
					</p>
				{/if}
				{#if !summaryFresh}
					<Button variant="secondary" class="min-h-11" disabled={refreshing} onclick={onrefresh}
						>Check booking again</Button
					>
				{/if}
				<Button
					type="submit"
					size="lg"
					class="min-h-13 w-full"
					disabled={!view.canConfirm || submitting || !summaryFresh || refreshing}
				>
					{submitting ? 'Submitting payment…' : `Pay ${formatCents(view.amount)}`}
				</Button>
			{/if}
		</form>
		<p class={cn(hintText, 'm-0 text-center')}>Secure payment powered by Stripe.</p>
	</section>

	<div class="border-t border-(--border-soft) pt-3">
		<Button
			variant="ghost"
			size="sm"
			class="min-h-11"
			disabled={submitting}
			onclick={() => onclose(launch.id)}>Back to booking overview</Button
		>
	</div>
</Card>
