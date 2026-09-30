<script lang="ts">
	import { capsSm, InstagramIcon, MapPinIcon, Wordmark } from '@fionas/ui';
	import { instagramUrl, mailtoUrl, site } from '@fionas/shared';
	import { cn } from '$lib/utils.js';
</script>

<footer class="mt-12 bg-olive-700 text-cream-200">
	<div
		class="mx-auto flex max-w-(--container-max) flex-wrap items-center gap-6 px-8 py-12 max-[760px]:flex-col max-[760px]:text-center"
	>
		<Wordmark class="text-cream-200" />
		<div
			class="ml-auto flex flex-col items-end gap-2 text-right max-[760px]:ml-0 max-[760px]:items-center max-[760px]:text-center"
		>
			<!-- eslint-disable svelte/no-navigation-without-resolve -- external Instagram / mailto links -->
			<a
				href={instagramUrl}
				target="_blank"
				rel="noopener noreferrer"
				class={cn(
					'flex items-center gap-2 text-cream-200 no-underline hover:text-cream-100',
					capsSm
				)}
			>
				<InstagramIcon />
				@{site.instagramHandle}
			</a>
			<span class="flex items-center gap-2 text-cream-300 [font:var(--type-body-sm)]">
				<MapPinIcon />
				{site.serviceArea}
			</span>
			<a
				href={mailtoUrl}
				class="text-cream-300 no-underline [font:var(--type-body-sm)] hover:text-cream-100"
			>
				{site.email}
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		</div>
	</div>
</footer>
