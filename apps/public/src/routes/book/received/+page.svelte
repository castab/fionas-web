<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button, Card, capsXs, cn } from '@fionas/ui';
	import { site } from '@fionas/shared';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Fiona's is in Fresno: show the time the way the team will see it.
	const received = $derived.by(() => {
		const date = new Date(data.receipt.createdAt);
		if (Number.isNaN(date.getTime())) return null;
		return new Intl.DateTimeFormat('en-US', {
			dateStyle: 'long',
			timeStyle: 'short',
			timeZone: 'America/Los_Angeles'
		}).format(date);
	});
</script>

<svelte:head>
	<title>Request received · {site.name}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main
	class="mx-auto w-full max-w-[640px] flex-1 px-6 pt-11 pb-[72px] max-[600px]:px-4 max-[600px]:pt-7"
>
	<Card class="flex flex-col items-start gap-4" role="status">
		<h1 class="m-0 text-(--text-heading) [font:var(--type-h2)]">
			Thanks — we got your request! 🍦
		</h1>
		<p class="m-0 text-(--text-body)">
			We'll be in touch at the email you gave us to talk through your event and send a firm quote.
			This is a request, not a booking: nothing is reserved or charged yet.
		</p>
		<dl class="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
			<dt class={cn(capsXs, 'self-center text-(--text-muted)')}>Reference</dt>
			<dd class="m-0 break-all text-(--text-heading) [font:var(--type-body-sm)]">
				{data.receipt.id}
			</dd>
			{#if received}
				<dt class={cn(capsXs, 'self-center text-(--text-muted)')}>Received</dt>
				<dd class="m-0 text-(--text-body) [font:var(--type-body-sm)]">{received}</dd>
			{/if}
		</dl>
		<Button href={resolve('/')} variant="secondary">Back to home</Button>
	</Card>
</main>
