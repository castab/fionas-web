<script lang="ts">
	import { resolve } from '$app/paths';
	import { Badge, Button, Card, capsSm, cn } from '@fionas/ui';
	import { mailtoUrl, site } from '@fionas/shared';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const steps = [
		'We review your request and reach out within a day to confirm timing, location, and finalize pricing.',
		"Once everything's agreed, we send over a firm quote and collect a deposit to hold your date.",
		"You're officially on the calendar — we'll send a confirmation with all the final details."
	];
</script>

<svelte:head>
	<title>Request received · {site.name}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main
	class="mx-auto w-full max-w-[640px] flex-1 px-6 pt-11 pb-[72px] max-[600px]:px-4 max-[600px]:pt-7"
>
	<div class="flex flex-col items-center gap-[18px] py-4 text-center" role="status">
		<Badge tone="olive">Request received</Badge>
		<h1
			class="m-0 font-sans text-[34px] leading-[1.2] font-bold tracking-(--track-heading) text-balance text-(--text-heading) max-[600px]:text-[28px]"
		>
			we got your request!
		</h1>
		<p class="m-0 max-w-[460px] text-(--text-body) [font:var(--type-body)]">
			Thanks{data.firstName ? `, ${data.firstName}` : ''} — we're excited about your event. This is just
			the start of the conversation: we'll follow up within a day to lock in the final details and price,
			including any travel fee if you're outside our usual area.
		</p>
		<p class="m-0 max-w-[460px] text-(--text-muted) [font:var(--type-body-sm)]">
			No scoops on the calendar just yet! Your date isn't held and you haven't paid a thing. That
			all comes after we chat.
		</p>
		<Card class="mt-1.5 flex w-full flex-col gap-3.5 px-[26px] py-6 text-left">
			<h2 class={cn(capsSm, 'm-0 text-(--text-heading)')}>What happens next</h2>
			<ol class="m-0 flex list-none flex-col gap-3.5 p-0">
				{#each steps as step, i (step)}
					<li class="flex items-start gap-3.5">
						<span
							aria-hidden="true"
							class="grid size-6 flex-none place-items-center rounded-full bg-olive-700 font-sans text-[11px] font-semibold text-cream-200"
						>
							{i + 1}
						</span>
						<span class="font-sans text-[13.5px] leading-[1.55] text-(--text-body)">{step}</span>
					</li>
				{/each}
			</ol>
		</Card>
		<p class="mt-1.5 mb-0 text-(--text-muted) [font:var(--type-body-sm)]">
			Questions in the meantime? Reach us at
			<!-- eslint-disable svelte/no-navigation-without-resolve -->
			<a href={mailtoUrl} class="text-olive-800 underline underline-offset-2 hover:text-olive-900"
				>{site.email}</a
			>.
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		</p>
		<Button href={resolve('/book')} variant="secondary" class="mt-1">Send another inquiry</Button>
	</div>
</main>
