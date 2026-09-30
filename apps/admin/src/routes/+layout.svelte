<script lang="ts">
	import './layout.css';
	import favicon from '@fionas/ui/assets/logo-badge.svg';
	import { resolve } from '$app/paths';
	import { Wordmark, capsSm } from '@fionas/ui';
	import { site } from '@fionas/shared';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Admin · {site.name}</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="flex min-h-dvh flex-col bg-(--surface-page)">
	<header class="bg-olive-700 text-cream-200">
		<div class="mx-auto flex max-w-(--container-max) items-center gap-4 px-8 py-3.5">
			<a href={resolve('/')} aria-label="Admin home" class="inline-flex text-cream-200">
				<Wordmark class="h-10" aria-hidden="true" />
			</a>
			<span class={`ml-auto text-cream-300 ${capsSm}`}>Admin</span>
		</div>
	</header>
	<div class="flex flex-1 flex-col">
		{@render children()}
	</div>
</div>
