<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import Badge, { badgeVariants } from '../badge/badge.svelte';
	import * as Popover from '../popover/index.js';
	import { focusRing } from '../../styles.js';
	import { cn, type WithElementRef } from '../../utils.js';

	/**
	 * A pill for picking from a short list (radio or checkbox). The native input fills the pill but
	 * is invisible, so it submits with the form, takes keyboard focus and receives the clicks.
	 * `unavailable` marks a choice that is listed but can't be picked right now: it fades and its
	 * badge's status note opens from anywhere on the pill (give it a badge + status note to explain
	 * why). Pair it with `disabled`.
	 *
	 * `badge` sits inside the pill; with a `statusNote` it opens that note in a dark bubble above
	 * (a status note without a badge is not shown). `infoNote` opens from an "i" button in a light card
	 * below. Both triggers sit beside the label, never inside it, so they never toggle the input.
	 */
	let {
		ref = $bindable(null),
		type = 'checkbox',
		label,
		meta,
		badge,
		statusNote,
		infoNote,
		'aria-describedby': describedby,
		unavailable = false,
		class: className,
		...restProps
	}: Omit<WithElementRef<HTMLInputAttributes, HTMLInputElement>, 'type' | 'children'> & {
		type?: 'radio' | 'checkbox';
		label: string;
		/** Short trailing note such as a price, e.g. "+$0.75/guest". */
		meta?: string;
		/** Short tag inside the pill, e.g. "Coming soon". */
		badge?: string;
		/** Opens from the badge; ignored without one. */
		statusNote?: string;
		/** Extra detail behind an "i" button, e.g. allergens. */
		infoNote?: string;
		/** Listed but temporarily not selectable. */
		unavailable?: boolean;
	} = $props();

	const uid = $props.id();
	const statusId = `${uid}-status`;
	const tag = $derived(badge?.trim() || undefined);
	const status = $derived(tag ? statusNote?.trim() || undefined : undefined);
	const info = $derived(infoNote?.trim() || undefined);
	const description = $derived(
		[describedby, status ? statusId : undefined].filter(Boolean).join(' ') || undefined
	);
	const tagClass = 'shrink-0 px-2 py-0.5 text-[9px] tracking-[0.05em] whitespace-nowrap';
	/** The pill: the status bubble centres over it, not over the badge. */
	let pill = $state<HTMLElement | null>(null);
</script>

<div
	bind:this={pill}
	data-slot="choice-chip"
	class={cn(
		'relative inline-flex max-w-full items-center gap-1.5 rounded-full border-[1.5px] px-4 py-[9px] break-words',
		'border-olive-300/70 bg-cream-100 font-sans text-xs leading-[1.4] font-semibold tracking-[0.05em] text-ink-700',
		'transition-[background-color,border-color,color] duration-(--dur-fast) ease-(--ease-out)',
		'hover:border-olive-500 has-checked:border-olive-700 has-checked:bg-olive-700 has-checked:text-cream-200',
		'has-[input:focus-visible]:outline-[3px] has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-(--focus-ring)',
		'has-disabled:opacity-45 has-disabled:hover:border-olive-300/70',
		unavailable &&
			'border-(--border-soft) text-(--text-muted) has-disabled:opacity-55 has-disabled:hover:border-(--border-soft)',
		className
	)}
	data-unavailable={unavailable ? '' : undefined}
>
	<label
		class="inline-flex min-w-0 cursor-pointer flex-wrap items-center gap-x-1.5 has-disabled:cursor-not-allowed"
	>
		<input
			bind:this={ref}
			{type}
			class="absolute inset-0 z-10 size-full cursor-[inherit] rounded-full opacity-0"
			{...restProps}
			aria-describedby={description}
		/>
		<span>{label}</span>
		{#if meta}<span class={cn('font-medium', !unavailable && 'opacity-75')}>· {meta}</span>{/if}
	</label>
	{#if tag && status}
		<Popover.Root>
			<!-- On an unavailable chip the trigger's ::after covers the whole pill, so tapping anywhere
			     on it opens the note (the disabled input can't take the click). -->
			<Popover.Trigger
				class={cn(
					badgeVariants({ tone: 'moss', size: 'sm' }),
					tagClass,
					'ml-0.5 cursor-pointer',
					focusRing,
					unavailable
						? "after:absolute after:inset-0 after:z-20 after:rounded-full after:content-['']"
						: 'relative z-20'
				)}
			>
				{tag}
			</Popover.Trigger>
			<Popover.Content
				side="top"
				sideOffset={8}
				customAnchor={pill}
				class="w-max max-w-[min(20rem,calc(100vw-2rem))] border-0 bg-olive-800 px-[15px] py-[9px] font-sans text-[12.5px] leading-[1.4] font-semibold text-cream-100"
			>
				{status}
			</Popover.Content>
		</Popover.Root>
		<span id={statusId} class="sr-only">{status}</span>
	{:else if tag}
		<Badge tone="moss" size="sm" class={cn(tagClass, 'ml-0.5')}>{tag}</Badge>
	{/if}
	{#if info}
		<Popover.Root>
			<Popover.Trigger
				aria-label="More about {label}"
				class={cn(
					'relative z-30 ml-0.5 inline-flex size-[15px] shrink-0 cursor-pointer items-center justify-center rounded-full bg-ink-700/15 text-[10px] leading-none font-bold tracking-normal',
					"after:absolute after:-inset-2 after:content-['']",
					focusRing
				)}
			>
				i
			</Popover.Trigger>
			<Popover.Content
				side="bottom"
				align="start"
				class="w-max max-w-[min(220px,calc(100vw-2rem))] font-sans text-xs leading-[1.4] break-words"
			>
				{info}
			</Popover.Content>
		</Popover.Root>
	{/if}
</div>
