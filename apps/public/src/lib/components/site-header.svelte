<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { Button, ComingSoonButton, Wordmark, capsSm, focusRing, cn } from '@fionas/ui';
	import { bookingComingSoon } from '$lib/coming-soon.js';

	let { bookingEnabled }: { bookingEnabled: boolean } = $props();
</script>

<header class="sticky top-0 z-10 border-b border-(--border-soft) bg-(--surface-page)">
	<div class="mx-auto flex max-w-(--container-max) items-center gap-6 px-8 py-3.5 max-[480px]:px-5">
		<a
			href={resolve('/')}
			aria-label="fionas ice cream — home"
			class={cn('inline-flex shrink-0', focusRing)}
		>
			<Wordmark class="h-10.5 text-olive-900" aria-hidden="true" />
		</a>
		<nav aria-label="Main" class="ml-auto flex shrink-0 items-center gap-2">
			<a
				href={resolve('/gallery')}
				aria-current={page.url.pathname === '/gallery' ? 'page' : undefined}
				class={cn(
					capsSm,
					focusRing,
					'inline-flex min-h-11 items-center rounded-full px-3.5 text-olive-800 no-underline transition-colors duration-(--dur-fast) ease-out hover:bg-cream-300 hover:text-olive-900',
					page.url.pathname === '/gallery' && 'bg-cream-300'
				)}>Gallery</a
			>
			{#if bookingEnabled}
				<Button href={resolve('/book')} size="sm">Book</Button>
			{:else}
				<ComingSoonButton toast={bookingComingSoon} size="sm">Book</ComingSoonButton>
			{/if}
		</nav>
	</div>
</header>
