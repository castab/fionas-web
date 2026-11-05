<script lang="ts">
	import { cn, focusRing } from '@fionas/ui';
	import { previewDocument } from '$lib/email-preview.js';

	let { html, text, subject }: { html: string; text: string; subject: string } = $props();
	let width = $state<'wide' | 'narrow'>('wide');
	// Backend markup is content, never UI behavior: it renders only inside an opaque-origin,
	// script-less sandbox with its own restrictive policy, never via {@html} in the admin DOM.
	const doc = $derived(previewDocument(html));
	const toggle = (active: boolean) =>
		cn(
			'min-h-9 cursor-pointer rounded-pill px-3 text-[11.5px] font-semibold transition-colors duration-(--dur-fast) ease-(--ease-out)',
			active
				? 'bg-olive-700 text-cream-200'
				: 'bg-transparent text-(--text-body) hover:bg-olive-700/10',
			focusRing
		);
</script>

<div class="flex min-w-0 flex-col gap-2.5" data-testid="email-preview">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<p class="m-0 text-[11.5px] text-(--text-muted)">
			Preview only. Links and images are disabled; the payment button points nowhere.
		</p>
		<div class="flex gap-1" role="group" aria-label="Preview width">
			<button
				type="button"
				class={toggle(width === 'wide')}
				aria-pressed={width === 'wide'}
				onclick={() => (width = 'wide')}>Desktop</button
			>
			<button
				type="button"
				class={toggle(width === 'narrow')}
				aria-pressed={width === 'narrow'}
				onclick={() => (width = 'narrow')}>Phone</button
			>
		</div>
	</div>
	<div class="min-w-0 overflow-hidden rounded-input border border-(--border-soft) bg-cream-200 p-2">
		<iframe
			title={`Email preview: ${subject}`}
			srcdoc={doc}
			sandbox=""
			referrerpolicy="no-referrer"
			loading="lazy"
			class={cn(
				'mx-auto block h-[560px] max-w-full border-0 bg-white',
				width === 'narrow' ? 'w-[375px]' : 'w-full'
			)}
			data-testid="email-preview-frame"
		></iframe>
	</div>
	<details class="group min-w-0">
		<summary
			class={cn(
				'inline-flex cursor-pointer list-none items-center rounded-full bg-olive-700/10 px-2.5 py-1 [&::-webkit-details-marker]:hidden',
				'font-sans text-[10px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-olive-800 uppercase',
				focusRing
			)}
			><span class="group-open:hidden">Show plain-text version</span><span
				class="hidden group-open:inline">Hide plain-text version</span
			></summary
		>
		<p
			class="m-0 mt-2.5 max-h-[420px] overflow-auto rounded-input bg-cream-200 px-3.5 py-3 text-[12.5px] leading-[1.6] wrap-anywhere whitespace-pre-wrap"
			data-testid="email-preview-text"
		>
			{text}
		</p>
	</details>
</div>
