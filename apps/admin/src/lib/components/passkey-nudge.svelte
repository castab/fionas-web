<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, Card } from '@fionas/ui';
	import {
		createPasskey,
		supportsAutomaticUpgrade,
		supportsPasskeys
	} from '$lib/passkey-client.js';
	import { dismissNudge, nudgeDismissed } from '$lib/passkeys.js';
	import { toast } from '$lib/toast.svelte.js';

	/**
	 * Shown once, right after a password sign-in by someone with no passkeys. Where the browser can,
	 * it first asks the password manager just used to create a passkey silently (an automatic
	 * passkey upgrade); otherwise, or when that doesn't happen, it offers one. "Not now" is
	 * remembered on this device for 30 days. The session is brand new, so no "Confirm it's you" is
	 * needed. See docs/admin-passkeys.md.
	 */
	let visible = $state(false);
	let creating = $state(false);
	let error = $state<string | null>(null);

	const storage = () => {
		try {
			return localStorage;
		} catch {
			return null;
		}
	};

	/** How long a silent upgrade may take before the prompt is offered anyway. */
	const UPGRADE_WAIT_MS = 3000;
	let created = false;

	onMount(() => {
		if (!supportsPasskeys() || nudgeDismissed(storage())) return;
		let active = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const offer = () => {
			if (active && !created) visible = true;
		};
		void (async () => {
			if (!(await supportsAutomaticUpgrade())) return offer();
			// A browser may leave the silent request pending; offer the prompt meanwhile. Choosing
			// "Create a passkey" there cancels the silent request.
			timer = setTimeout(offer, UPGRADE_WAIT_MS);
			const outcome = await createPasskey({ automatic: true });
			clearTimeout(timer);
			if (!active) return;
			if (outcome.ok) {
				created = true;
				visible = false;
				toast.success('Passkey created. Next time, sign in with it.');
			} else offer();
		})();
		return () => {
			active = false;
			clearTimeout(timer);
		};
	});

	async function create() {
		if (creating) return;
		creating = true;
		error = null;
		const outcome = await createPasskey();
		creating = false;
		if (outcome.ok) {
			created = true;
			visible = false;
			toast.success('Passkey created. Next time, sign in with it.');
		} else if (outcome.failure) error = outcome.failure.message;
	}

	function notNow() {
		dismissNudge(storage());
		visible = false;
	}
</script>

{#if visible}
	<Card
		variant="flat"
		class="mx-auto mb-5 flex w-full max-w-[760px] flex-col gap-3 p-[18px]"
		role="region"
		aria-labelledby="passkey-nudge-title"
		data-testid="passkey-nudge"
	>
		<div class="flex flex-col gap-1">
			<h2
				id="passkey-nudge-title"
				class="m-0 font-sans text-[15px] leading-[1.4] font-bold text-(--text-heading)"
			>
				Sign in faster with a passkey
			</h2>
			<p class="m-0 text-sm leading-[1.55] text-(--text-body)">
				Use your fingerprint, face, or screen lock instead of typing your password.
			</p>
		</div>
		<div class="flex flex-wrap gap-2">
			<Button size="sm" onclick={create} disabled={creating}>
				{creating ? 'Creating…' : 'Create a passkey'}
			</Button>
			<Button size="sm" variant="ghost" onclick={notNow} disabled={creating}>Not now</Button>
		</div>
		{#if error}
			<p role="alert" class="m-0 text-sm text-rust-600">{error}</p>
		{/if}
	</Card>
{/if}
