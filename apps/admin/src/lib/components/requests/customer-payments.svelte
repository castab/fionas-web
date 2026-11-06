<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { Badge, Button, Card } from '@fionas/ui';
	import type { CurrentStaffRequest, InquiryStage } from '$lib/request-contract.js';
	import {
		attemptDocumentLabel,
		attemptsNeedingAttention,
		classifyAttempt,
		currentPaymentTerms,
		supersededCopy,
		type AttemptAttention
	} from '$lib/checkout-attempts.js';
	import {
		attemptOutcomeLabels,
		attemptPurposeLabel,
		attemptStateLabels,
		canIssuePaymentLink,
		canReconcileAttempt,
		customerPaymentsErrorMessage,
		formatMinor,
		type CustomerPaymentsResult,
		type CustomerPaymentsView,
		type PaymentAttempt,
		type PaymentLinkIntent
	} from '$lib/customer-payments.js';
	import { receivedTimeLabel } from '$lib/payments.js';
	import { attemptRefresh } from '$lib/attempt-refresh.js';
	import { workspaceAction, type RequestListQuery } from '$lib/request-list.js';

	let {
		stage,
		request,
		view,
		result = null,
		endpoint,
		route,
		returnContext = null,
		refreshSignal = 0,
		onsettlement
	}: {
		stage: InquiryStage;
		/** The live authoritative staff request: attempts are compared with its current terms. */
		request: CurrentStaffRequest;
		view: CustomerPaymentsView;
		/** A native (no-JavaScript) action result; enhanced results stay local to this card. */
		result?: CustomerPaymentsResult | null;
		/** `/requests/{id}/customer-payments`, the read-only refresh endpoint. */
		endpoint: string;
		/** The workspace URL with its return context, for Reload to review. */
		route: string;
		returnContext?: RequestListQuery | null;
		/** Increments after each authoritative Activity refresh (live timeline updates). */
		refreshSignal?: number;
		/** An enhanced Stripe check may have changed settlement: re-read Right now and Activity. */
		onsettlement?: () => void;
	} = $props();

	const initial = untrack(() => {
		let current = view;
		if (current.availability === 'ready' && result?.link)
			current = { ...current, link: result.link };
		if (current.availability === 'ready' && result?.attempts !== undefined)
			current = { ...current, attempts: result.attempts };
		return current;
	});
	let current = $state<CustomerPaymentsView>(initial);
	let busy = $state<PaymentLinkIntent | null>(null);
	// The attempt a Stripe check is running for: every other check waits until it answers.
	let busyAttempt = $state<string | null>(null);
	let message = $state(untrack(() => result?.message ?? ''));
	let messageTone = $state(untrack(() => result?.messageTone ?? 'positive'));
	let error = $state(untrack(() => result?.error ?? ''));
	let reviewRequired = $state(untrack(() => !!result?.reviewRequired));
	// The usable link, shown only after a deliberate reveal when the clipboard is unavailable.
	// Component memory only; cleared on hide and after two minutes.
	let revealed = $state<string | null>(untrack(() => result?.url ?? null));
	let attemptsOpen = $state(false);
	let attemptsStale = $state(false);
	let refreshing = $state(false);
	// The staff-request snapshot the shown attempts were read alongside. The two reads move at
	// different moments; until they pair up again nothing is offered as a release.
	let attemptsBasis = $state.raw(untrack(() => request));
	// The latest attempt read failed: the last known attempts stay, marked possibly out of date.
	let attemptsUnconfirmed = $state(false);
	let revealTimer: ReturnType<typeof setTimeout> | undefined;

	const action = $derived(workspaceAction(returnContext, 'customerPayments'));
	const issuable = $derived(canIssuePaymentLink(stage));
	const link = $derived(current.availability === 'ready' ? current.link : null);
	const attempts = $derived(current.availability === 'ready' ? current.attempts : null);
	// Presentation only: commerce alone decides whether a check expires a session.
	const terms = $derived(currentPaymentTerms(request));
	const needsReconciliation = $derived(
		attempts?.some(
			(attempt) => classifyAttempt(attempt, terms).status === 'reconciliation_required'
		) ?? false
	);
	const attention = $derived(attemptsNeedingAttention(attempts, terms));
	// Attempts and terms come from reads that pair up, and the latest read succeeded.
	const confirmed = $derived(attemptsBasis === request && !attemptsUnconfirmed);
	// Notices outside the diagnostics disclosure that live updates must keep accurate.
	const prominent = $derived(attention.length > 0 || needsReconciliation);

	function hideRevealed() {
		revealed = null;
		clearTimeout(revealTimer);
	}

	function showRevealed(url: string) {
		revealed = url;
		clearTimeout(revealTimer);
		revealTimer = setTimeout(hideRevealed, 120_000);
	}

	$effect(() => () => clearTimeout(revealTimer));

	/**
	 * Starts a clipboard write inside the click's user activation, with the text delivered once the
	 * server answers (Safari requires this); falls back to writeText, then to a selectable field.
	 */
	function startCopy() {
		let deliver: (text: string) => void = () => undefined;
		let cancelCopy: () => void = () => undefined;
		const text = new Promise<string>((resolve, reject) => {
			deliver = resolve;
			cancelCopy = () => reject(new Error('No link'));
		});
		text.catch(() => undefined);
		let written: Promise<boolean> = Promise.resolve(false);
		try {
			if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write)
				written = navigator.clipboard
					.write([
						new ClipboardItem({
							'text/plain': text.then((value) => new Blob([value], { type: 'text/plain' }))
						})
					])
					.then(
						() => true,
						() => false
					);
		} catch {
			written = Promise.resolve(false);
		}
		return {
			async finish(url: string | undefined): Promise<boolean> {
				if (!url) {
					cancelCopy();
					return false;
				}
				deliver(url);
				if (await written) return true;
				try {
					await navigator.clipboard.writeText(url);
					return true;
				} catch {
					return false;
				}
			}
		};
	}

	function apply(next: CustomerPaymentsResult | undefined, intent: PaymentLinkIntent) {
		if (!next) {
			error = customerPaymentsErrorMessage(intent, 503);
			reviewRequired = intent !== 'reveal';
			return;
		}
		if (current.availability === 'ready') {
			if (next.link) current = { ...current, link: next.link };
			if (next.attempts !== undefined) {
				// Newer than any read already in flight, which is then discarded and read again.
				refresher?.local();
				if (next.attempts === null && current.attempts) attemptsUnconfirmed = true;
				else {
					current = { ...current, attempts: next.attempts };
					attemptsBasis = request;
					attemptsUnconfirmed = false;
				}
			}
		}
		error = next.error ?? '';
		message = next.message ?? '';
		messageTone = next.messageTone ?? 'positive';
		if (next.reviewRequired) reviewRequired = true;
		if (next.link && next.link.state !== 'active') hideRevealed();
		// A captured or applied payment changes Right now and Activity, not just this card.
		if (next.settlement && !next.reviewRequired) onsettlement?.();
	}

	function submitter(intent: PaymentLinkIntent, attemptId?: string): SubmitFunction {
		return ({ cancel }) => {
			// One deliberate submission, one request: duplicates and blocked states never post.
			if (busy || reviewRequired) {
				cancel();
				return;
			}
			busy = intent;
			busyAttempt = attemptId ?? null;
			error = '';
			message = '';
			if (intent === 'rotate' || intent === 'revoke') hideRevealed();
			const copy = intent === 'reveal' ? startCopy() : null;
			return async ({ result: outcome }) => {
				try {
					if (outcome.type === 'redirect') {
						window.location.assign(outcome.location);
						return;
					}
					const data =
						outcome.type === 'success' || outcome.type === 'failure'
							? (outcome.data?.customerPayments as CustomerPaymentsResult | undefined)
							: undefined;
					apply(data, intent);
					if (copy) {
						const url = data?.url;
						if (await copy.finish(url)) {
							hideRevealed();
							message = 'Payment link copied. Paste it into your message to the customer.';
						} else if (url) {
							showRevealed(url);
							message = "Copying isn't available here. Select the link below and copy it.";
						} else if (!data?.error) error = 'This request has no active payment link to copy.';
					}
				} finally {
					busy = null;
					busyAttempt = null;
				}
			};
		};
	}

	function isView(value: unknown): value is CustomerPaymentsView {
		if (typeof value !== 'object' || value === null) return false;
		const v = value as { availability?: unknown; link?: { state?: unknown }; attempts?: unknown };
		if (v.availability !== 'ready')
			return ['disabled', 'forbidden', 'unavailable'].includes(v.availability as string);
		return (
			['none', 'active', 'revoked'].includes(v.link?.state as string) &&
			(v.attempts === null || Array.isArray(v.attempts))
		);
	}

	/** A refreshed view, unless it lost attempts we had: then the last known stay, unconfirmed. */
	function applyView(next: CustomerPaymentsView, basis: CurrentStaffRequest) {
		const known = current.availability === 'ready' ? current.attempts : null;
		const lost =
			next.availability === 'unavailable' ||
			(next.availability === 'ready' && next.attempts === null);
		if (known && lost) {
			if (next.availability === 'ready') current = { ...next, attempts: known };
			attemptsUnconfirmed = true;
			attemptsStale = true;
			return;
		}
		current = next;
		attemptsBasis = basis;
		attemptsUnconfirmed = false;
		attemptsStale = false;
	}

	// One serialized read loop: overlapping hints coalesce, one arriving mid-read is kept for
	// another pass, and a read older than a reconcile answer never overwrites it.
	let refresher:
		ReturnType<typeof attemptRefresh<CustomerPaymentsView, CurrentStaffRequest>> | undefined;
	$effect(() => {
		const target = endpoint;
		return untrack(() => {
			const loop = attemptRefresh<CustomerPaymentsView, CurrentStaffRequest>({
				async read(signal) {
					const response = await fetch(target, {
						cache: 'no-store',
						signal: AbortSignal.any([signal, AbortSignal.timeout(15000)])
					});
					const next: unknown = await response.json();
					if (!response.ok || !isView(next)) throw new Error('Unavailable attempts');
					return next;
				},
				basis: () => request,
				apply: applyView,
				busy(value) {
					refreshing = value;
				},
				failure() {
					// The last known attempts stay visible, marked possibly out of date.
					attemptsUnconfirmed = true;
					attemptsStale = true;
				}
			});
			refresher = loop;
			return () => loop.dispose();
		});
	});
	const refresh = () => void refresher?.request();
	/** Refresh now when attempt data is on screen (diagnostics or a notice), else when opened. */
	function refreshIfShown() {
		if (attemptsOpen || prominent) refresh();
		else attemptsStale = true;
	}

	// Live timeline updates (after each authoritative Activity read).
	let seenSignal = untrack(() => refreshSignal);
	$effect(() => {
		const signal = refreshSignal;
		untrack(() => {
			if (signal === seenSignal) return;
			seenSignal = signal;
			refreshIfShown();
		});
	});
	// A newer staff-request projection (a settled payment, a booked request, a new revision): pair
	// the attempts with it before anything is offered against the new terms.
	$effect(() => {
		const latest = request;
		untrack(() => {
			if (latest !== attemptsBasis && current.availability === 'ready') refreshIfShown();
		});
	});

	function toggleAttempts(event: Event) {
		attemptsOpen = (event.currentTarget as HTMLDetailsElement).open;
		if (attemptsOpen && attemptsStale) refresh();
	}

	const caps =
		'm-0 font-sans text-[11px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-heading) uppercase';
	const note = 'm-0 text-[12.5px] leading-[1.55] text-(--text-muted)';
	const summaryClass =
		'cursor-pointer rounded-sm font-sans text-[12.5px] font-semibold text-olive-800 select-none hover:text-olive-900 focus-visible:outline-solid focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)';
	// Tone and labels follow the classification, so an incoherent pair never reads as paid.
	const statusOf = (attempt: PaymentAttempt) => classifyAttempt(attempt, terms).status;
	const stateTone = (attempt: PaymentAttempt) => {
		const status = statusOf(attempt);
		return status === 'reconciliation_required' || status === 'unrecognized'
			? 'rust'
			: status === 'applied'
				? 'moss'
				: 'outline';
	};
	const stateLabel = (attempt: PaymentAttempt) =>
		statusOf(attempt) === 'unrecognized'
			? 'Status unclear'
			: (attemptStateLabels[attempt.state] ?? attempt.state);
	const outcomeLabel = (attempt: PaymentAttempt) =>
		statusOf(attempt) === 'unrecognized'
			? 'Outcome not confirmed'
			: (attemptOutcomeLabels[attempt.outcome] ?? attempt.outcome);
	const paymentOf = (attempt: PaymentAttempt) =>
		`${attempt.purpose === 'DEPOSIT' ? 'deposit' : attempt.purpose === 'INVOICE' ? 'Invoice payment' : 'payment'} of ${formatMinor(attempt.authorizedMinor)}`;
	const attentionHeading: Record<AttemptAttention['kind'], string> = {
		release: 'Previous checkout is still open',
		confirming: 'A payment is being confirmed',
		unconfirmed: 'Checkout status isn’t confirmed',
		uncertain: 'Checkout status needs investigation'
	};
	/** Release is offered only while the shown attempts and terms are confirmed together. */
	const releasable = (item: AttemptAttention) => item.kind === 'release' && confirmed;
	const headingOf = (item: AttemptAttention) =>
		item.kind === 'release' && !confirmed
			? 'Previous checkout may still be open'
			: attentionHeading[item.kind];
	function attentionCopy(item: AttemptAttention): string[] {
		const payment = paymentOf(item.attempt);
		const article = item.attempt.purpose === 'INVOICE' ? 'an' : 'a';
		switch (item.status) {
			case 'open_superseded':
				return [
					`The customer started ${article} ${payment} using an earlier version of this booking. ${supersededCopy(item.attempt, item.reasons, terms)}`,
					confirmed
						? 'You can check with Stripe and request release of that checkout so they can pay against the updated terms from the same link. Emailing the updated document doesn’t depend on this.'
						: 'Its latest status isn’t confirmed here. Checking asks commerce, which releases it only if its terms are still out of date. Emailing the updated document doesn’t depend on this.'
				];
			case 'unrecognized':
				return [
					`Commerce reported a status for ${article} ${payment} that this console can’t interpret, so it isn’t shown as paid, applied or released.`,
					'Reload to read it again. If it stays unclear, investigate it in the Stripe Dashboard before taking or recording another payment.'
				];
			case 'processing':
				return [
					`Stripe is confirming the customer’s ${payment}. Don’t start or record another payment until it settles.`
				];
			case 'paid_pending':
				return [
					`Stripe reports the customer’s ${payment} succeeded, but it isn’t applied to the booking yet. Don’t collect it again.`
				];
			case 'creating':
				return [
					`Checkout for ${article} ${payment} was started, but commerce hasn’t confirmed it with Stripe yet. Checking never creates a second charge.`
				];
			default:
				return [
					`A checkout for ${article} ${payment} is open, and its terms can’t be compared from here. Checking lets commerce compare them: it releases a checkout only when its terms are out of date.`
				];
		}
	}
	const rowNote = (attempt: PaymentAttempt) => {
		const { status, reasons } = classifyAttempt(attempt, terms);
		return status === 'open_superseded'
			? `Earlier terms. ${supersededCopy(attempt, reasons, terms)}`
			: status === 'open_current'
				? 'Matches the current terms.'
				: null;
	};
	const toneClass = {
		positive: 'text-moss-600',
		neutral: 'text-(--text-body)',
		warning: 'text-rust-600'
	} as const;
</script>

<Card
	variant="flat"
	class="flex min-w-0 flex-col gap-3 p-[18px]"
	role="region"
	aria-labelledby="customer-payments-title"
	id="customer-payments"
	data-testid="customer-payments"
>
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h2 id="customer-payments-title" class={caps}>Customer payments</h2>
		{#if link}
			<Badge
				size="sm"
				tone={link.state === 'active' ? 'moss' : link.state === 'revoked' ? 'rust' : 'outline'}
				data-testid="payment-link-status"
				>{link.state === 'active'
					? 'Link active'
					: link.state === 'revoked'
						? 'Link revoked'
						: 'No link'}</Badge
			>
		{/if}
	</div>

	{#if current.availability === 'disabled'}
		<p class={note}>
			Online payments are turned off in commerce, so there is no customer payment link. Manual
			payments still work.
		</p>
	{:else if current.availability === 'forbidden'}
		<p class={note}>Customer payment links aren't available for your account.</p>
	{:else if current.availability === 'unavailable'}
		<p class={note}>Payment link status is unavailable right now. Reload to try again.</p>
	{:else if link}
		{#if link.state === 'none'}
			<p class={note}>
				{issuable
					? 'Create a secure page where the customer can pay online. The same link keeps working through Quote revisions and Invoice amendments.'
					: 'This booking is closed, so a new payment link cannot be created.'}
			</p>
			{#if issuable}
				<form method="POST" {action} use:enhance={submitter('issue')}>
					<input type="hidden" name="intent" value="issue" />
					<Button
						type="submit"
						variant="secondary"
						class="min-h-11 w-full"
						disabled={!!busy || reviewRequired}
						data-testid="create-payment-link"
						>{busy === 'issue' ? 'Creating…' : 'Create payment link'}</Button
					>
				</form>
			{/if}
		{:else if link.state === 'revoked'}
			<p class={note}>
				This link was revoked, so the customer can't open it. Payments already underway can still be
				reconciled.
			</p>
			{#if issuable}
				<form method="POST" {action} use:enhance={submitter('issue')}>
					<input type="hidden" name="intent" value="issue" />
					<Button
						type="submit"
						variant="secondary"
						class="min-h-11 w-full"
						disabled={!!busy || reviewRequired}
						data-testid="create-payment-link"
						>{busy === 'issue' ? 'Issuing…' : 'Issue a new payment link'}</Button
					>
				</form>
				<p class={note}>A new link has a new secret; copies of the revoked link stay disabled.</p>
			{/if}
		{:else}
			<p class={note}>
				The customer's link stays the same through Quote revisions and Invoice amendments. Copying
				it doesn't change it.
			</p>
			<form method="POST" {action} use:enhance={submitter('reveal')}>
				<input type="hidden" name="intent" value="reveal" />
				<Button
					type="submit"
					class="min-h-11 w-full"
					disabled={!!busy || reviewRequired}
					data-testid="copy-payment-link"
					>{busy === 'reveal' ? 'Copying…' : 'Copy payment link'}</Button
				>
			</form>
			{#if revealed}
				<div class="flex flex-col gap-1.5" data-testid="payment-link-fallback">
					<label for="payment-link-url" class="text-[11.5px] font-semibold text-(--text-heading)"
						>Payment link (treat it like a password)</label
					>
					<input
						id="payment-link-url"
						readonly
						value={revealed}
						onfocus={(event) => event.currentTarget.select()}
						class="w-full rounded-input border border-olive-300/70 bg-cream-100 px-3 py-2 font-mono text-[12px] text-(--text-body)"
					/>
					<Button variant="ghost" size="sm" class="self-start" onclick={hideRevealed}
						>Hide link</Button
					>
				</div>
			{/if}
			<details class="flex flex-col gap-2" data-testid="manage-payment-link">
				<summary class={summaryClass}>Manage link</summary>
				<div class="mt-2 flex flex-col gap-3 border-l-2 border-(--border-soft) pl-3">
					{#if issuable}
						<details>
							<summary class={summaryClass}>Rotate link…</summary>
							<div class="mt-2 flex flex-col gap-2">
								<p class="m-0 text-[12.5px] leading-[1.55] text-(--text-body)">
									Rotating replaces the secret right away. Every copy of the current link stops
									working, and you'll need to send the customer the new one.
								</p>
								<form method="POST" {action} use:enhance={submitter('rotate')}>
									<input type="hidden" name="intent" value="rotate" />
									<input type="hidden" name="confirm" value="rotate" />
									<Button
										type="submit"
										variant="secondary"
										size="sm"
										disabled={!!busy || reviewRequired}
										data-testid="rotate-payment-link"
										>{busy === 'rotate' ? 'Rotating…' : 'Rotate link'}</Button
									>
								</form>
							</div>
						</details>
					{/if}
					<details>
						<summary class={summaryClass}>Revoke link…</summary>
						<div class="mt-2 flex flex-col gap-2">
							<p class="m-0 text-[12.5px] leading-[1.55] text-(--text-body)">
								Revoking stops the customer from opening the link or starting a payment. Payments
								already underway can still be reconciled.
							</p>
							<form method="POST" {action} use:enhance={submitter('revoke')}>
								<input type="hidden" name="intent" value="revoke" />
								<input type="hidden" name="confirm" value="revoke" />
								<Button
									type="submit"
									variant="secondary"
									size="sm"
									class="border-rust-600 text-rust-600 not-disabled:hover:bg-rust-600/10"
									disabled={!!busy || reviewRequired}
									data-testid="revoke-payment-link"
									>{busy === 'revoke' ? 'Revoking…' : 'Revoke link'}</Button
								>
							</form>
						</div>
					</details>
				</div>
			</details>
		{/if}

		{#if needsReconciliation}
			<p
				class="m-0 rounded-input border border-rust-600 bg-rust-600/5 px-3 py-2 text-[12.5px] leading-[1.5] text-(--text-body)"
				data-testid="reconciliation-warning"
			>
				An online payment was received but not applied to this booking. It needs staff
				reconciliation before any further collection.
			</p>
		{/if}

		{#if attemptsUnconfirmed && (prominent || attemptsOpen)}
			<!-- The last attempt read failed: what follows is the last known state, not a confirmation. -->
			<p
				role="status"
				class="m-0 rounded-input border border-olive-700/25 bg-cream-200 px-3 py-2 text-[12.5px] leading-[1.5] text-(--text-body)"
				data-testid="checkout-status-stale"
			>
				We couldn’t refresh the checkout status, so what’s shown may be out of date.
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- route is the page's resolve()d workspace URL -->
				<a href={route} data-sveltekit-reload class="font-semibold underline">Reload to review</a> before
				acting on it.
			</p>
		{/if}

		{#if attention.length}
			<!-- Checkouts that need a staff decision, outside the diagnostics disclosure. Each posts the
			     existing reconcile command for exactly its attempt; commerce decides what Stripe does. -->
			<ul class="m-0 flex list-none flex-col gap-2 p-0">
				{#each attention as item (item.attempt.id)}
					<li
						class={[
							'flex flex-col gap-2 rounded-input border px-3 py-2.5',
							item.kind === 'confirming' || item.kind === 'uncertain'
								? 'border-rust-600/40 bg-rust-600/5'
								: 'border-olive-700/25 bg-olive-700/8'
						]}
						data-testid={item.kind === 'release' ? 'previous-checkout' : 'checkout-status'}
						data-attempt-id={item.attempt.id}
						data-status={item.status}
						data-confirmed={confirmed}
					>
						<p class="m-0 text-[13px] leading-[1.45] font-semibold text-(--text-body)">
							{headingOf(item)}
						</p>
						{#each attentionCopy(item) as paragraph, index (index)}
							<p class="m-0 text-[12.5px] leading-[1.55] text-(--text-body)">{paragraph}</p>
						{/each}
						{#if item.kind === 'uncertain'}
							<Button
								href={route}
								data-sveltekit-reload
								variant="secondary"
								class="min-h-11 w-full"
								data-testid="reload-checkout-status">Reload to review</Button
							>
						{:else}
							<form method="POST" {action} use:enhance={submitter('reconcile', item.attempt.id)}>
								<input type="hidden" name="intent" value="reconcile" />
								<input type="hidden" name="attemptId" value={item.attempt.id} />
								<Button
									type="submit"
									variant="secondary"
									class="min-h-11 w-full"
									disabled={!!busy || reviewRequired}
									data-testid={releasable(item)
										? 'release-previous-checkout'
										: 'check-payment-status'}
									>{busyAttempt === item.attempt.id
										? 'Checking with Stripe…'
										: releasable(item)
											? 'Release previous checkout'
											: 'Check payment status'}</Button
								>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		<details ontoggle={toggleAttempts} data-testid="payment-attempts">
			<summary class={summaryClass}
				>Online payment attempts{attempts ? ` (${attempts.length})` : ''}{refreshing
					? ' · refreshing'
					: attemptsUnconfirmed
						? ' · may be out of date'
						: ''}</summary
			>
			<div class="mt-2 flex flex-col gap-2">
				<p class={note}>
					Stripe Checkout diagnostics. These are not ledger records: Activity and Right now show
					what has been applied.
				</p>
				{#if attempts === null}
					<p class={note}>Attempt details are unavailable right now.</p>
				{:else if attempts.length === 0}
					<p class={note}>No online payment attempts yet.</p>
				{:else}
					<ul class="m-0 flex list-none flex-col gap-2 p-0">
						{#each attempts as attempt (attempt.id)}
							{@const termsNote = rowNote(attempt)}
							<li
								class={[
									'flex flex-col gap-1 rounded-input border px-3 py-2.5',
									statusOf(attempt) === 'reconciliation_required' ||
									statusOf(attempt) === 'unrecognized'
										? 'border-rust-600 bg-rust-600/5'
										: 'border-(--border-soft)'
								]}
								data-testid="payment-attempt"
								data-outcome={attempt.outcome}
							>
								<div class="flex flex-wrap items-center justify-between gap-2">
									<span class="text-[13px] font-semibold text-(--text-body)"
										>{attemptPurposeLabel(attempt.purpose)} · {formatMinor(
											attempt.authorizedMinor
										)}</span
									>
									<Badge size="sm" tone={stateTone(attempt)}>{stateLabel(attempt)}</Badge>
								</div>
								<span class="text-[11.5px] leading-[1.5] text-(--text-muted)">
									<time datetime={attempt.createdAt}>{receivedTimeLabel(attempt.createdAt)}</time>
									· {attemptDocumentLabel(attempt)} · {outcomeLabel(attempt)} · {attempt.ledgerPaymentId
										? 'Ledger payment recorded'
										: 'No ledger payment'}
								</span>
								{#if termsNote}
									<span
										class="text-[11.5px] leading-[1.5] text-(--text-muted)"
										data-testid="payment-attempt-terms">{termsNote}</span
									>
								{/if}
								{#if statusOf(attempt) === 'reconciliation_required'}
									<span class="text-[11.5px] leading-[1.5] text-rust-600"
										>Money reached the ledger but was not allocated automatically. Review unapplied
										payments; checking again will not allocate it.</span
									>
								{/if}
								{#if attempt.diagnostic}
									<span class="text-[11.5px] wrap-anywhere text-(--text-muted)"
										>Diagnostic: <code>{attempt.diagnostic}</code></span
									>
								{/if}
								{#if canReconcileAttempt(attempt)}
									<details>
										<summary class={summaryClass}>Check with Stripe…</summary>
										<div class="mt-1.5 flex flex-col gap-1.5">
											<p class={note}>
												Asks Stripe for this attempt's latest status. Commerce releases an open
												checkout only when its terms are out of date. It never creates a new charge,
												and it can't allocate an unapplied payment on its own.
											</p>
											<form method="POST" {action} use:enhance={submitter('reconcile', attempt.id)}>
												<input type="hidden" name="intent" value="reconcile" />
												<input type="hidden" name="attemptId" value={attempt.id} />
												<Button
													type="submit"
													variant="secondary"
													size="sm"
													disabled={!!busy || reviewRequired}
													data-testid="reconcile-attempt"
													>{busyAttempt === attempt.id
														? 'Checking with Stripe…'
														: 'Check payment status'}</Button
												>
											</form>
										</div>
									</details>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</details>
	{/if}

	<p
		class={['m-0 text-[12.5px] leading-[1.5]', toneClass[messageTone]]}
		role="status"
		data-testid="customer-payments-status"
		data-tone={message ? messageTone : undefined}
	>
		{message}
	</p>
	{#if error}
		<div role="alert" class="flex flex-col items-start gap-2" data-testid="customer-payments-error">
			<p class="m-0 text-[12.5px] leading-[1.5] text-rust-600">{error}</p>
			{#if reviewRequired}
				<Button href={route} data-sveltekit-reload variant="secondary" size="sm"
					>Reload to review</Button
				>
			{/if}
		</div>
	{/if}
</Card>
