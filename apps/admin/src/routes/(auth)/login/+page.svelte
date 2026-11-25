<script lang="ts">
	import { applyAction, enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onMount, untrack } from 'svelte';
	import { Button, Field, Input, Wordmark } from '@fionas/ui';
	import { loginSuccessMessage } from '$lib/login.js';
	import {
		cancelCeremony,
		signInWithPasskey,
		supportsAutofill,
		supportsPasskeys
	} from '$lib/passkey-client.js';
	import { toast } from '$lib/toast.svelte.js';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();

	// Only the initial values matter: the server echoes them for the no-JS path, then the client
	// owns this state. The password is never echoed.
	const initial = untrack(() => ({
		username: form?.username ?? '',
		formError: form?.formError ?? null
	}));

	let username = $state(initial.username);
	let formError = $state<string | null>(initial.formError);
	let submitting = $state(false);

	// Passkeys need JavaScript and WebAuthn, so their button appears only once both are known.
	let passkeysAvailable = $state(false);
	let passkeyBusy = $state(false);
	let passkeyError = $state<string | null>(null);
	let autofill = false;
	let destroyed = false;

	onMount(() => {
		passkeysAvailable = supportsPasskeys();
		void supportsAutofill().then((available) => {
			autofill = available;
			void runAutofill();
		});
		return () => {
			destroyed = true;
			cancelCeremony();
		};
	});

	/** Passkeys are switched off in this deployment: no button, no autofill, no error. */
	function passkeysOff() {
		passkeysAvailable = false;
		autofill = false;
		cancelCeremony();
	}

	async function signedIn() {
		toast.success(loginSuccessMessage);
		await goto(resolve('/'), { invalidateAll: true });
	}

	/**
	 * Offers passkeys in the User field's autofill (conditional mediation). It waits until the
	 * person picks one; the passkey button cancels it and starts it again when it is done.
	 */
	async function runAutofill() {
		if (!autofill || destroyed) return;
		const outcome = await signInWithPasskey({ autofill: true });
		if (destroyed) return;
		if (outcome.ok) return signedIn();
		if (outcome.failure?.code === 'passkeys_disabled') return passkeysOff();
		if (outcome.failure) {
			passkeyError = outcome.failure.message;
			void runAutofill();
		}
	}

	async function signInWithPasskeyButton() {
		if (passkeyBusy) return;
		passkeyBusy = true;
		passkeyError = null;
		formError = null;
		const outcome = await signInWithPasskey();
		passkeyBusy = false;
		if (outcome.ok) return signedIn();
		if (outcome.failure?.code === 'passkeys_disabled') return passkeysOff();
		if (outcome.failure) passkeyError = outcome.failure.message;
		void runAutofill();
	}
</script>

<svelte:head>
	<title>Sign in · Admin · Fiona's Ice Cream</title>
</svelte:head>

<main
	class="flex min-h-dvh flex-col items-center justify-center gap-7 bg-(--surface-page) px-4 py-10"
>
	<Wordmark class="h-[95px] text-ink-700" />

	<form
		method="POST"
		novalidate
		class="flex w-full max-w-[400px] flex-col gap-[18px] rounded-card bg-(--surface-card) p-7 shadow-card"
		use:enhance={() => {
			submitting = true;
			return async ({ result, update }) => {
				if (result.type === 'redirect') {
					toast.success(loginSuccessMessage);
					await applyAction(result);
				} else {
					await update({ reset: false });
					if (result.type === 'failure') {
						formError = (result.data?.formError as string | undefined) ?? null;
						if (formError) toast.error(formError);
					} else if (result.type === 'error') {
						formError = 'Sign in is unavailable right now. Try again shortly.';
						toast.error(formError);
					}
				}
				submitting = false;
			};
		}}
	>
		<div class="flex flex-col gap-1.5">
			<h1 class="m-0 tracking-(--track-heading) text-(--text-heading) [font:var(--type-h1)]">
				sign in
			</h1>
			<p class="m-0 text-(--text-muted) [font:var(--type-body-sm)]">
				Booking requests, quotes &amp; the calendar.
			</p>
		</div>

		<Field label="User">
			{#snippet children({ id, describedby })}
				<Input
					{id}
					name="username"
					autocomplete="username webauthn"
					autocapitalize="none"
					spellcheck={false}
					placeholder="fiona"
					required
					bind:value={username}
					aria-describedby={describedby}
					aria-invalid={formError ? true : undefined}
					oninput={() => (formError = null)}
				/>
			{/snippet}
		</Field>

		<Field label="Password">
			{#snippet children({ id, describedby })}
				<Input
					{id}
					name="password"
					type="password"
					autocomplete="current-password"
					placeholder="••••••••"
					required
					aria-describedby={describedby}
					aria-invalid={formError ? true : undefined}
					oninput={() => (formError = null)}
				/>
			{/snippet}
		</Field>

		{#if formError}
			<p role="alert" class="m-0 font-sans text-[12.5px] leading-normal text-rust-600">
				{formError}
			</p>
		{/if}

		<Button type="submit" size="lg" disabled={submitting || passkeyBusy}>
			{submitting ? 'Signing in…' : 'Sign in'}
		</Button>

		{#if passkeysAvailable}
			<div class="flex items-center gap-3" aria-hidden="true">
				<span class="h-px flex-1 bg-(--border-soft)"></span>
				<span class="font-sans text-xs text-(--text-muted)">or</span>
				<span class="h-px flex-1 bg-(--border-soft)"></span>
			</div>
			<Button
				variant="secondary"
				size="lg"
				onclick={signInWithPasskeyButton}
				disabled={submitting || passkeyBusy}
				data-testid="passkey-sign-in"
			>
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.8"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<circle cx="7.5" cy="15.5" r="5.5"></circle>
					<path d="m21 2-9.6 9.6"></path>
					<path d="m15.5 7.5 3 3L22 7l-3-3"></path>
				</svg>
				{passkeyBusy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
			</Button>
			{#if passkeyError}
				<p
					role="alert"
					class="m-0 font-sans text-[12.5px] leading-normal text-rust-600"
					data-testid="passkey-error"
				>
					{passkeyError}
				</p>
			{/if}
		{/if}
	</form>
</main>
