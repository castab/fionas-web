<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { env } from '$env/dynamic/public';
	import { Badge, Button, Card, capsSm, cn } from '@fionas/ui';
	import { instagramUrl, mailtoUrl, site } from '@fionas/shared';
	import { paymentStore } from '$lib/payments/checkout.js';
	import {
		createPaymentController,
		type PageState,
		type PaymentController
	} from '$lib/payments/controller.js';
	import { noticeCopy, STATUS_UNKNOWN_MESSAGE } from '$lib/payments/copy.js';
	import { stageLabel } from '$lib/payments/view.js';
	import { readPublishableKey } from '$lib/payments/embedded.js';
	import EmbeddedCheckout from '$lib/components/payments/embedded-checkout.svelte';
	import PaymentAction from '$lib/components/payments/payment-action.svelte';
	import PaymentNotice from '$lib/components/payments/payment-notice.svelte';
	import PaymentHistory from '$lib/components/payments/payment-history.svelte';
	import PaymentOverview from '$lib/components/payments/payment-overview.svelte';

	// The bearer never reaches this component's state or the server: it lives in the controller's
	// closure and this tab's sessionStorage only.
	let view = $state.raw<PageState | null>(null);
	let controller: PaymentController | null = null;

	onMount(() => {
		const publicId = page.params.publicId ?? '';
		const path = resolve('/pay/[publicId=uuid]', { publicId });
		let storage: Storage | null;
		try {
			storage = window.sessionStorage;
		} catch {
			storage = null;
		}
		const created = createPaymentController({
			publicId,
			store: paymentStore(publicId, storage),
			hash: window.location.hash,
			search: window.location.search,
			// Drops the fragment (and any ?checkout= return marker) from the address bar and this
			// history entry at once, keeping SvelteKit's own history state. SvelteKit's page.url is
			// then synced once hydration has finished (its router can't navigate during onMount).
			clearUrl() {
				window.history.replaceState(window.history.state, '', path);
				void tick().then(() => {
					try {
						replaceState(path, page.state);
					} catch {
						// The address bar is already clean; only SvelteKit's copy of the URL is stale.
					}
				});
			},
			fetch: (input, init) => fetch(input, init),
			navigate: (url) => window.location.assign(url),
			uuid: () => crypto.randomUUID(),
			visible: () => document.visibilityState === 'visible',
			onVisible(listener) {
				document.addEventListener('visibilitychange', listener);
				return () => document.removeEventListener('visibilitychange', listener);
			},
			onState(next) {
				view = next;
			}
		});
		controller = created;
		// Opening another link in this tab only changes the fragment: start again from it.
		const reopened = () => {
			if (window.location.hash.length > 1) window.location.reload();
		};
		window.addEventListener('hashchange', reopened);
		void created.start();
		return () => {
			window.removeEventListener('hashchange', reopened);
			created.dispose();
		};
	});

	const notice = $derived(
		view?.notice ? noticeCopy(view.notice, view.summary, view.paymentUncertain) : null
	);
	const ready = $derived(view?.phase === 'ready' && view.summary ? view : null);
	// Public by design (a Stripe publishable key); only needed once an embedded payment opens.
	const publishableKey = readPublishableKey(env.PUBLIC_STRIPE_PUBLISHABLE_KEY);
	const headline =
		'm-0 font-sans text-[34px] leading-[1.2] font-bold tracking-(--track-heading) text-balance text-(--text-heading) max-[600px]:text-[28px]';
</script>

<svelte:head>
	<title>Your booking · {site.name}</title>
	<meta name="robots" content="noindex, nofollow" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>

{#snippet message(title: string, text: string, retry = false)}
	<Card
		class="flex flex-col items-start gap-3.5 px-[26px] py-6 max-[600px]:px-5"
		data-testid="payment-message"
	>
		<h2 class="m-0 font-sans text-lg leading-[1.35] font-bold text-(--text-heading)">{title}</h2>
		<p class="m-0 text-(--text-body) [font:var(--type-body-sm)]">{text}</p>
		<div class="flex flex-wrap gap-3">
			{#if retry}
				<Button onclick={() => controller?.refresh()} disabled={view?.busy !== null}
					>Try again</Button
				>
			{/if}
			<Button href={mailtoUrl} variant="secondary">Email us</Button>
		</div>
	</Card>
{/snippet}

<main
	class="mx-auto flex w-full max-w-[720px] flex-1 flex-col gap-5 px-6 pt-11 pb-[72px] max-[600px]:px-4 max-[600px]:pt-7"
	data-sveltekit-preload-data="off"
	data-testid="pay-page"
>
	<header class="flex flex-col items-start gap-3">
		<Badge tone={ready ? 'inverse' : 'olive'} data-testid="stage-label"
			>{ready?.summary ? stageLabel(ready.summary) : 'Booking & payments'}</Badge
		>
		<h1 class={headline}>your booking</h1>
		<p class="m-0 text-(--text-muted) [font:var(--type-body-sm)]">
			Review your event and pay securely online. No account needed.
		</p>
	</header>

	<!-- Static markup only: with JavaScript on, browsers keep noscript content as inert text, so a
	     component here would break hydration. Styled like a raised Card. -->
	<noscript>
		<div
			class="flex flex-col gap-3 rounded-card bg-(--surface-card) px-[26px] py-6 shadow-card"
			data-testid="no-js"
		>
			<h2 class="m-0 font-sans text-lg font-bold text-(--text-heading)">
				Please turn on JavaScript to continue
			</h2>
			<p class="m-0 text-(--text-body) [font:var(--type-body)]">
				For your security, this payment page opens your booking privately in your browser, which
				needs JavaScript. Turn it on and reopen your payment link, or email us at
				contact@fionasicecream.com and we'll help you pay another way.
			</p>
		</div>
	</noscript>

	{#if view === null || view.phase === 'initializing'}
		<p
			role="status"
			class="m-0 text-(--text-muted) [font:var(--type-body-sm)]"
			data-testid="pay-loading"
		>
			{view ? 'Opening your booking…' : ''}
		</p>
	{:else if view.phase === 'link-required'}
		{@render message(
			'Payment link required',
			"For your security, this page opens only from the payment link we sent you. Please reopen that link, including everything after the # sign. Can't find it? Email us and we'll send it again."
		)}
	{:else if view.phase === 'link-incomplete'}
		{@render message(
			'This payment link looks incomplete',
			'Part of the link may be missing. Copy the entire link from our message and open it again.'
		)}
	{:else if view.phase === 'link-unavailable'}
		{@render message(
			'This payment link is no longer active',
			view.paymentUncertain
				? "It may have been replaced with a newer link, so we can't show the status of a payment you started from it. Please don't pay again until you've contacted us; we'll check it and send your current link."
				: 'It may have been replaced with a newer link. Contact us and we will send your current one.'
		)}
	{:else if view.phase === 'payments-disabled'}
		<!-- An outage says nothing about money: with a payment possibly underway, never reassure. -->
		{@render message(
			view.paymentUncertain
				? "We can't confirm your payment status"
				: "Online payments aren't available right now",
			view.paymentUncertain
				? STATUS_UNKNOWN_MESSAGE
				: 'Online payments aren’t available right now. Please try again later or contact us for help.'
		)}
	{:else if view.phase === 'unreachable'}
		{@render message(
			view.paymentUncertain
				? "We can't confirm your payment status"
				: "We can't load your booking right now",
			view.paymentUncertain
				? STATUS_UNKNOWN_MESSAGE
				: 'Check your connection and try again in a moment.',
			true
		)}
	{:else if ready?.summary}
		{#if !ready.persistent}
			<p class="m-0 text-(--text-muted) [font:var(--type-body-sm)]" data-testid="storage-note">
				Your browser isn't letting this page remember your link. If you leave, reopen the payment
				link from our message to come back.
			</p>
		{/if}
		{#if notice}<PaymentNotice {notice} />{/if}
		<PaymentOverview summary={ready.summary} />
		{#if ready.embedded}
			<!-- Keyed by launch: a new authorization always gets a fresh Stripe instance. -->
			{#key ready.embedded.id}
				<EmbeddedCheckout
					launch={ready.embedded}
					{publishableKey}
					oncomplete={(id) => controller?.embeddedComplete(id)}
					onclose={() => controller?.closeEmbedded()}
				/>
			{/key}
		{:else}
			<PaymentAction
				current={ready}
				onpay={(choice) => controller?.pay(choice)}
				onrecover={(choice) => controller?.recover(choice)}
				onretry={() => controller?.retry()}
				onstartover={() => controller?.startOver()}
				onrefresh={() => controller?.refresh()}
			/>
		{/if}
		<PaymentHistory history={ready.summary.history} />
	{/if}

	<section
		aria-labelledby="pay-help"
		class="flex flex-col gap-2 rounded-card border border-(--border-soft) px-[26px] py-5 max-[600px]:px-5"
	>
		<h2 id="pay-help" class={cn(capsSm, 'm-0 text-(--text-heading)')}>Need a hand?</h2>
		<p class="m-0 text-(--text-body) [font:var(--type-body-sm)]">
			If a payment doesn't go through or something looks off, we're happy to help. Email
			<!-- eslint-disable svelte/no-navigation-without-resolve -- external contact links -->
			<a href={mailtoUrl} class="text-olive-800 underline underline-offset-2 hover:text-olive-900"
				>{site.email}</a
			>
			or message us on
			<a
				href={instagramUrl}
				rel="noopener noreferrer"
				target="_blank"
				class="text-olive-800 underline underline-offset-2 hover:text-olive-900">Instagram</a
			>.
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		</p>
	</section>
</main>
