<script lang="ts">
	import { applyAction, enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import { Button, Field, Input, Wordmark } from '@fionas/ui';
	import { loginSuccessMessage } from '$lib/login.js';
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
</script>

<svelte:head>
	<title>Sign in · Admin · Fiona's Ice Cream</title>
</svelte:head>

<main
	class="flex min-h-dvh flex-col items-center justify-center gap-6 bg-(--surface-page) px-5 py-10"
>
	<Wordmark class="h-[95px] text-ink-700" />

	<form
		method="POST"
		novalidate
		class="flex w-full max-w-[400px] flex-col gap-[18px] rounded-card bg-(--surface-card) px-[26px] pt-7 pb-[26px] shadow-raised"
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
				admin sign in
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
					autocomplete="username"
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

		<Button type="submit" size="lg" disabled={submitting}>
			{submitting ? 'Signing in…' : 'Sign in'}
		</Button>
	</form>
</main>
