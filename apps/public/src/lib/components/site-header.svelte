<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button, ComingSoonButton, Wordmark } from '@fionas/ui';
	import { bookingComingSoon } from '$lib/coming-soon.js';

	let { bookingEnabled }: { bookingEnabled: boolean } = $props();
</script>

<header class="sticky top-0 z-10 border-b border-(--border-soft) bg-(--surface-page)">
	<div class="mx-auto flex max-w-(--container-max) items-center gap-6 px-8 py-3.5">
		<a href={resolve('/')} aria-label="fionas ice cream — home" class="inline-flex">
			<Wordmark class="text-olive-900" aria-hidden="true" />
		</a>
		{#if bookingEnabled}
			<Button href={resolve('/book')} size="sm" class="ml-auto">Book</Button>
		{:else}
			<ComingSoonButton toast={bookingComingSoon} size="sm" class="ml-auto">Book</ComingSoonButton>
		{/if}
	</div>
</header>
