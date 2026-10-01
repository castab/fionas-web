<script lang="ts">
	import { cn } from '@fionas/ui';
	import { toast } from '$lib/toast.svelte.js';

	const current = $derived(toast.current);
</script>

<!-- Temporary: see toast.svelte.ts. Errors are announced assertively, success politely. -->
{#if current}
	{#key current.key}
		<div
			role={current.tone === 'error' ? 'alert' : 'status'}
			class={cn(
				'toast fixed bottom-6 left-1/2 z-50 flex max-w-[calc(100%-2.5rem)] items-center gap-2.5',
				'rounded-full bg-ink-900 px-[22px] py-3 text-center',
				'font-sans text-[12.5px] font-semibold text-cream-200 shadow-raised'
			)}
		>
			<span
				aria-hidden="true"
				class={cn(
					'size-2 shrink-0 rounded-full',
					current.tone === 'error' ? 'bg-rust-600' : 'bg-moss-600'
				)}
			></span>
			{current.message}
		</div>
	{/key}
{/if}

<style>
	.toast {
		transform: translateX(-50%);
		animation: toast-up var(--dur-med) var(--ease-out);
	}

	@keyframes toast-up {
		from {
			opacity: 0;
			transform: translate(-50%, 8px);
		}
		to {
			opacity: 1;
			transform: translate(-50%, 0);
		}
	}
</style>
