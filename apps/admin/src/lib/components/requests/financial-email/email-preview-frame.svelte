<script lang="ts">
	import { cn, focusRing } from '@fionas/ui';
	import { previewDocument } from '$lib/email-preview.js';

	let { html, text, subject }: { html: string; text: string; subject: string } = $props();
	let width = $state<'wide' | 'narrow'>('wide');
	let full = $state(false);
	// Backend markup is content, never UI behavior: it renders only inside an opaque-origin,
	// script-less sandbox with its own restrictive policy, never via {@html} in the admin DOM.
	const doc = $derived(previewDocument(html));
	const phone = $derived(width === 'narrow');
	const toggle = (active: boolean) =>
		cn(
			'min-h-9 cursor-pointer rounded-full px-3 text-[11.5px] font-semibold transition-colors duration-(--dur-fast) ease-(--ease-out)',
			active
				? 'bg-olive-700 text-cream-200'
				: 'bg-transparent text-(--text-body) hover:bg-olive-700/10',
			focusRing
		);
	// The chip style the plain-text toggle already used; focus shows on the chip, not the hidden box.
	const chip = cn(
		'inline-flex min-h-6 cursor-pointer items-center rounded-full bg-olive-700/10 px-2.5 py-1',
		'font-sans text-[10px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-olive-800 uppercase',
		'has-focus-visible:outline-solid has-focus-visible:outline-[3px] has-focus-visible:outline-offset-2 has-focus-visible:outline-(--focus-ring)'
	);
</script>

<!-- The sandboxed frame has an opaque origin, so its content can't be measured from here. The
     full-length toggle switches to a tall fixed height instead of loosening the sandbox. It is a
     checkbox styled as a chip, so it also works without JavaScript (`group-has-checked`). -->
<div class="group/preview flex min-w-0 flex-col gap-2.5" data-testid="email-preview">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<p class="m-0 text-[11.5px] text-(--text-muted)">
			Preview only — links and images are turned off, and the payment button goes nowhere.
		</p>
		<div class="flex gap-1" role="group" aria-label="Preview width">
			<button
				type="button"
				class={toggle(!phone)}
				aria-pressed={!phone}
				onclick={() => (width = 'wide')}>Desktop</button
			>
			<button
				type="button"
				class={toggle(phone)}
				aria-pressed={phone}
				onclick={() => (width = 'narrow')}>Phone</button
			>
		</div>
	</div>
	<div
		class={cn(
			'min-w-0 overflow-hidden rounded-input border border-(--border-soft) bg-cream-200',
			phone ? 'px-2 py-5' : 'p-2'
		)}
	>
		<!-- Phone: the email at 375px inside a simple handset outline. Desktop: full width, no outline. -->
		<div
			class={cn(
				'mx-auto box-border max-w-full',
				phone ? 'w-[399px] rounded-card bg-ink-700 px-3 pt-3 pb-[18px]' : 'w-full'
			)}
			data-testid="email-preview-device"
			data-device={phone ? 'phone' : 'desktop'}
		>
			{#if phone}<div
					aria-hidden="true"
					class="mx-auto mb-2.5 h-[5px] w-16 rounded-full bg-ink-500"
					data-testid="email-preview-speaker"
				></div>{/if}
			<iframe
				id="email-preview-frame"
				title={`Email preview: ${subject}`}
				srcdoc={doc}
				sandbox=""
				referrerpolicy="no-referrer"
				loading="lazy"
				scrolling={full ? 'no' : 'auto'}
				class={cn(
					'mx-auto block h-[720px] w-full max-w-full border-0 bg-white group-has-[#email-preview-full:checked]/preview:h-[1800px]',
					phone && 'rounded-input'
				)}
				data-testid="email-preview-frame"
			></iframe>
		</div>
	</div>
	<div class="flex flex-wrap items-center gap-2">
		<label class={chip}>
			<input
				id="email-preview-full"
				type="checkbox"
				bind:checked={full}
				aria-controls="email-preview-frame"
				class="peer sr-only"
				data-testid="email-preview-full"
			/><span class="group-has-[#email-preview-full:checked]/preview:hidden"
				>Show the whole email</span
			><span class="hidden group-has-[#email-preview-full:checked]/preview:inline"
				>Shorter preview</span
			>
		</label>
		<label class={chip}>
			<input
				id="email-preview-plain"
				type="checkbox"
				aria-controls="email-preview-text"
				class="peer sr-only"
				data-testid="email-preview-plain"
			/><span class="group-has-[#email-preview-plain:checked]/preview:hidden"
				>Show plain-text version</span
			><span class="hidden group-has-[#email-preview-plain:checked]/preview:inline"
				>Hide plain-text version</span
			>
		</label>
	</div>
	<p
		id="email-preview-text"
		class="m-0 hidden max-h-[420px] overflow-auto rounded-input bg-cream-200 px-3.5 py-3 text-[12.5px] leading-[1.6] wrap-anywhere whitespace-pre-wrap group-has-[#email-preview-plain:checked]/preview:block"
		data-testid="email-preview-text"
	>
		{text}
	</p>
</div>
