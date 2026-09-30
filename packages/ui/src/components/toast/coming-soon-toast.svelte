<script lang="ts">
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { Button } from '../button/index.js';
	import { CloseIcon } from '../icons/index.js';
	import { capsSm, focusRing } from '../../styles.js';
	import { cn } from '../../utils.js';
	import {
		comingSoonToastState,
		dismissComingSoonToast,
		pauseComingSoonToast,
		resumeComingSoonToast
	} from './coming-soon-toast-state.svelte.js';

	const toast = comingSoonToastState();
</script>

<!-- Mount once in the root layout. Positioned by this wrapper so the toast's own fly transform
     doesn't fight the horizontal centering. -->
<div
	class="pointer-events-none fixed bottom-6 left-1/2 z-60 w-[min(380px,calc(100vw-48px))] -translate-x-1/2 max-[560px]:right-4 max-[560px]:left-4 max-[560px]:w-auto max-[560px]:translate-x-0"
	role="region"
	aria-label="Notifications"
	aria-live="polite"
>
	{#if toast.visible}
		<div
			role="status"
			class="toast pointer-events-auto overflow-hidden rounded-card border border-(--border-soft) bg-(--surface-card) shadow-card"
			onmouseenter={pauseComingSoonToast}
			onmouseleave={resumeComingSoonToast}
			onfocusin={pauseComingSoonToast}
			onfocusout={resumeComingSoonToast}
			in:fly={{ y: 14, duration: 200, easing: cubicOut }}
			out:fly={{ y: 14, duration: 160 }}
		>
			<div class="flex gap-3 px-4 pt-4 pb-3.5">
				<div class="flex min-w-0 flex-auto flex-col gap-1.5">
					<p class={cn('m-0 text-olive-900', capsSm)}>{toast.title}</p>
					<p class="m-0 text-pretty text-(--text-muted) [font:var(--type-body-sm)]">
						{toast.description}
					</p>
					<div class="mt-2 flex">
						<Button
							href={toast.actionHref}
							target="_blank"
							rel="noopener noreferrer"
							size="sm"
							class="max-[560px]:w-full"
						>
							{toast.actionLabel}
						</Button>
					</div>
				</div>
				<button
					type="button"
					aria-label="Dismiss"
					onclick={dismissComingSoonToast}
					class={cn(
						'-mt-1 -mr-1 grid size-7 flex-none cursor-pointer place-items-center rounded-full border-0 bg-transparent text-(--text-muted)',
						'transition-colors duration-(--dur-fast) ease-out hover:bg-cream-300 hover:text-olive-900',
						focusRing
					)}
				>
					<CloseIcon />
				</button>
			</div>
			{#if toast.timeoutMs > 0}
				{#key toast.updateKey}
					<span
						data-slot="toast-timer"
						aria-hidden="true"
						class="timer block h-[3px] origin-left bg-olive-600 opacity-35"
						style:animation-duration="{toast.timeoutMs}ms"
					></span>
				{/key}
			{/if}
		</div>
	{/if}
</div>

<style>
	.timer {
		animation-name: toast-timer;
		animation-timing-function: linear;
		animation-fill-mode: forwards;
	}

	.toast:hover .timer,
	.toast:focus-within .timer {
		animation-play-state: paused;
	}

	@keyframes toast-timer {
		from {
			transform: scaleX(1);
		}
		to {
			transform: scaleX(0);
		}
	}
</style>
