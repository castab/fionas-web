<script lang="ts">
	import { Badge, Button, ComingSoonButton, LogoBadge } from '@fionas/ui';
	import { bookingLaunchLabel, instagramUrl } from '@fionas/shared';
	import { resolve } from '$app/paths';
	import { bookingComingSoon } from '$lib/coming-soon.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<!-- Hero: copy (left) + olive-disc badge (right). Below 940px it stacks, badge on top. -->
<main
	class="mx-auto flex w-full max-w-(--container-max) flex-1 flex-wrap items-center justify-center gap-x-14 gap-y-12 px-8 pt-14 pb-10 max-[940px]:flex-col max-[940px]:gap-8 max-[940px]:pt-8 max-[940px]:text-center"
>
	<div
		class="flex max-w-[560px] flex-[1_1_380px] flex-col items-start gap-[22px] max-[940px]:max-w-none max-[940px]:flex-none max-[940px]:items-center"
	>
		{#if !data.bookingEnabled}
			<Badge tone="moss">{bookingLaunchLabel}</Badge>
		{/if}

		<h1
			class="m-0 font-sans text-[42px] leading-[1.1] font-bold tracking-(--track-heading) text-balance text-(--text-heading)"
		>
			Classic hand-scooped ice cream and sweet treats!
		</h1>

		<p class="m-0 max-w-[500px] text-(--text-body) [font:var(--type-body)] max-[940px]:max-w-none">
			Soft serve &amp; hand-scooped classics towed to your driveway, park, or backyard across Fresno
			&amp; the Madera Ranchos. Our little website is churning — follow along while we set up.
		</p>

		<div class="mt-0.5 flex flex-wrap gap-3 max-[940px]:justify-center min-[600px]:flex-nowrap">
			<Button href={instagramUrl} target="_blank" rel="noopener noreferrer" size="lg">
				Follow on Instagram
			</Button>
			{#if data.bookingEnabled}
				<Button href={resolve('/book')} variant="secondary" size="lg">Book the trailer</Button>
			{:else}
				<ComingSoonButton toast={bookingComingSoon} variant="secondary" size="lg">
					Book the trailer
				</ComingSoonButton>
			{/if}
		</div>
	</div>

	<div class="grid flex-[0_1_auto] place-items-center max-[940px]:-order-1">
		<LogoBadge class="size-[clamp(286px,31vw,432px)] max-[940px]:size-[286px]" />
	</div>
</main>
