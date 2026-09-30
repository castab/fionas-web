<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { Button } from '@fionas/ui';

	const notFound = $derived(page.status === 404);
</script>

<main
	class="mx-auto flex w-full max-w-(--container-max) flex-1 flex-col items-start justify-center gap-4 px-8 py-16 max-[600px]:px-4"
>
	<h1
		class="m-0 font-sans text-[42px] leading-[1.1] font-bold tracking-(--track-heading) text-balance text-(--text-heading) max-[600px]:text-[32px]"
	>
		{notFound ? 'Page not found' : 'Something went wrong'}
	</h1>
	<p class="m-0 max-w-[500px] text-(--text-body) [font:var(--type-body)]">
		{notFound
			? "We couldn't find the page you were looking for."
			: 'Please try again in a little while.'}
	</p>
	<Button href={resolve('/')}>Back to home</Button>
</main>
