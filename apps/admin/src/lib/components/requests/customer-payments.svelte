<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { Badge, Button, Card } from '@fionas/ui';
	import type { InquiryStage } from '$lib/request-contract.js';
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
	import { workspaceAction, type RequestListQuery } from '$lib/request-list.js';

	let {
		stage,
		view,
		result = null,
		endpoint,
		route,
		returnContext = null,
		refreshSignal = 0
	}: {
		stage: InquiryStage;
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
	let message = $state(untrack(() => result?.message ?? ''));
	let error = $state(untrack(() => result?.error ?? ''));
	let reviewRequired = $state(untrack(() => !!result?.reviewRequired));
	// The usable link, shown only after a deliberate reveal when the clipboard is unavailable.
	// Component memory only; cleared on hide and after two minutes.
	let revealed = $state<string | null>(untrack(() => result?.url ?? null));
	let attemptsOpen = $state(false);
	let attemptsStale = $state(false);
	let refreshing = $state(false);
	let revealTimer: ReturnType<typeof setTimeout> | undefined;

	const action = $derived(workspaceAction(returnContext, 'customerPayments'));
	const issuable = $derived(canIssuePaymentLink(stage));
	const link = $derived(current.availability === 'ready' ? current.link : null);
	const attempts = $derived(current.availability === 'ready' ? current.attempts : null);
	const needsReconciliation = $derived(
		attempts?.some((attempt) => attempt.outcome === 'RECONCILIATION_REQUIRED') ?? false
	);

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
			if (next.attempts !== undefined) current = { ...current, attempts: next.attempts };
		}
		error = next.error ?? '';
		message = next.message ?? '';
		if (next.reviewRequired) reviewRequired = true;
		if (next.link && next.link.state !== 'active') hideRevealed();
	}

	function submitter(intent: PaymentLinkIntent): SubmitFunction {
		return ({ cancel }) => {
			if (busy || reviewRequired) {
				cancel();
				return;
			}
			busy = intent;
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

	async function refresh() {
		if (refreshing) return;
		refreshing = true;
		try {
			const response = await fetch(endpoint, {
				cache: 'no-store',
				signal: AbortSignal.timeout(15000)
			});
			const next: unknown = await response.json();
			if (response.ok && isView(next)) {
				current = next;
				attemptsStale = false;
			}
		} catch {
			// The previously loaded diagnostics stay visible; a later notification can recover.
		} finally {
			refreshing = false;
		}
	}

	// Live timeline updates: refresh diagnostics now when displayed, otherwise when next opened.
	let seenSignal = untrack(() => refreshSignal);
	$effect(() => {
		const signal = refreshSignal;
		untrack(() => {
			if (signal === seenSignal) return;
			seenSignal = signal;
			if (attemptsOpen) void refresh();
			else attemptsStale = true;
		});
	});

	function toggleAttempts(event: Event) {
		attemptsOpen = (event.currentTarget as HTMLDetailsElement).open;
		if (attemptsOpen && attemptsStale) void refresh();
	}

	const caps =
		'm-0 font-sans text-[11px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-heading) uppercase';
	const note = 'm-0 text-[12.5px] leading-[1.55] text-(--text-muted)';
	const summaryClass =
		'cursor-pointer rounded-sm font-sans text-[12.5px] font-semibold text-olive-800 select-none hover:text-olive-900 focus-visible:outline-solid focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)';
	const stateTone = (attempt: PaymentAttempt) =>
		attempt.outcome === 'RECONCILIATION_REQUIRED'
			? 'rust'
			: attempt.outcome === 'APPLIED'
				? 'moss'
				: 'outline';
	const documentOf = (attempt: PaymentAttempt) =>
		`${attempt.purpose === 'DEPOSIT' ? 'Quote' : 'Invoice'} v${attempt.businessRevision}`;
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

		<details ontoggle={toggleAttempts} data-testid="payment-attempts">
			<summary class={summaryClass}
				>Online payment attempts{attempts ? ` (${attempts.length})` : ''}{refreshing
					? ' · refreshing'
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
							<li
								class={[
									'flex flex-col gap-1 rounded-input border px-3 py-2.5',
									attempt.outcome === 'RECONCILIATION_REQUIRED'
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
									<Badge size="sm" tone={stateTone(attempt)}
										>{attemptStateLabels[attempt.state] ?? attempt.state}</Badge
									>
								</div>
								<span class="text-[11.5px] leading-[1.5] text-(--text-muted)">
									<time datetime={attempt.createdAt}>{receivedTimeLabel(attempt.createdAt)}</time>
									· {documentOf(attempt)} · {attemptOutcomeLabels[attempt.outcome] ??
										attempt.outcome} · {attempt.ledgerPaymentId
										? 'Ledger payment recorded'
										: 'No ledger payment'}
								</span>
								{#if attempt.outcome === 'RECONCILIATION_REQUIRED'}
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
												Asks Stripe for this attempt's latest status. It never creates a new charge,
												and it can't allocate an unapplied payment on its own.
											</p>
											<form method="POST" {action} use:enhance={submitter('reconcile')}>
												<input type="hidden" name="intent" value="reconcile" />
												<input type="hidden" name="attemptId" value={attempt.id} />
												<Button
													type="submit"
													variant="secondary"
													size="sm"
													disabled={!!busy || reviewRequired}
													data-testid="reconcile-attempt"
													>{busy === 'reconcile' ? 'Checking…' : 'Check now'}</Button
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
		class="m-0 text-[12.5px] leading-[1.5] text-moss-600"
		role="status"
		data-testid="customer-payments-status"
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
