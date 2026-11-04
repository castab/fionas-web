<script lang="ts">
	import { cn } from '@fionas/ui';
	import { mailtoUrl, site } from '@fionas/shared';
	import type { NoticeCopy } from '$lib/payments/copy.js';

	let { notice }: { notice: NoticeCopy } = $props();

	const tones = {
		success: 'border-moss-600 bg-moss-600/10',
		info: 'border-olive-300 bg-cream-100',
		warning: 'border-olive-700 bg-olive-100/50',
		error: 'border-rust-600 bg-rust-600/5'
	} as const;
</script>

<!-- Errors interrupt (alert); everything else is announced politely. Focus never moves. -->
<div
	role={notice.tone === 'error' ? 'alert' : 'status'}
	class={cn('flex flex-col gap-1 rounded-[10px] border-2 px-5 py-4', tones[notice.tone])}
	data-testid="payment-notice"
	data-tone={notice.tone}
>
	<p class="m-0 font-sans text-[15px] leading-snug font-semibold text-(--text-heading)">
		{notice.title}
	</p>
	<p class="m-0 text-(--text-body) [font:var(--type-body-sm)]">
		{notice.body}
		{#if notice.contact}
			<!-- eslint-disable svelte/no-navigation-without-resolve -- external mailto link -->
			<a href={mailtoUrl} class="text-olive-800 underline underline-offset-2 hover:text-olive-900"
				>{site.email}</a
			>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{/if}
	</p>
</div>
