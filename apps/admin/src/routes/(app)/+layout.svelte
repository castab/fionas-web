<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import { Wordmark, capsSm, focusRing } from '@fionas/ui';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();
</script>

<div class="flex min-h-dvh flex-col bg-(--surface-page)">
	<header class="bg-olive-700 text-cream-200">
		<div class="mx-auto flex max-w-(--container-max) items-center gap-4 px-8 py-3.5">
			<a href={resolve('/')} aria-label="Admin home" class="inline-flex text-cream-200">
				<Wordmark class="h-10" aria-hidden="true" />
			</a>
			<span class={`ml-auto text-cream-300 max-[600px]:hidden ${capsSm}`}>
				{data.user.displayName}
			</span>
			<form method="POST" action={resolve('/logout')}>
				<button
					type="submit"
					class={`cursor-pointer rounded-full px-3 py-1.5 text-cream-200 underline-offset-4 hover:underline ${capsSm} ${focusRing}`}
				>
					Sign out
				</button>
			</form>
		</div>
	</header>
	<div class="flex flex-1 flex-col">
		{@render children()}
	</div>
</div>
