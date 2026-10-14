<script lang="ts">
	import { onMount } from 'svelte';
	import { loadTurnstile } from '$lib/turnstile.js';
	import { hintText } from '@fionas/ui';
	let { siteKey, token = $bindable('') }: { siteKey: string | null; token?: string } = $props();
	let container = $state<HTMLDivElement>();
	let unavailable = $state(false);
	let attempt = $state(0);
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	$effect(() => {
		const key = siteKey;
		const target = container;
		void attempt;
		if (!target) return;
		let cancelled = false;
		let id: string | undefined;
		unavailable = false;
		token = '';
		if (!key) {
			unavailable = true;
			return;
		}
		loadTurnstile()
			.then(() => {
				if (cancelled) return;
				if (!window.turnstile) {
					unavailable = true;
					return;
				}
				id = window.turnstile.render(target, {
					sitekey: key,
					theme: 'light',
					size: 'flexible',
					action: 'booking',
					callback: (value) => {
						token = value;
						unavailable = false;
					},
					'expired-callback': () => {
						token = '';
					},
					'error-callback': () => {
						token = '';
						unavailable = true;
					}
				});
			})
			.catch(() => {
				if (!cancelled) unavailable = true;
			});
		return () => {
			cancelled = true;
			if (id !== undefined) window.turnstile?.remove(id);
		};
	});
</script>

<div class="sr-only" aria-hidden="true" inert>
	<label for="booking-website">Leave this field empty</label>
	<input id="booking-website" name="website" type="text" tabindex="-1" autocomplete="off" />
</div>
<div class="flex w-full flex-col gap-2">
	<p class={`${hintText} m-0`}>Quick human check. Faster than picking a flavor!</p>
	<div class="w-full" bind:this={container} data-turnstile-complete={token.length > 0}></div>
</div>
{#if unavailable}
	<p role="alert" class={hintText}>
		The security check couldn't load. Please check your connection and
		<button type="button" class="underline" onclick={() => attempt++}>try again</button>.
	</p>
{/if}
{#if !mounted}
	<p class={hintText}>
		Please enable JavaScript to complete the security check and send your request.
	</p>
{/if}
