<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Wordmark, focusRing } from '@fionas/ui';
	import { initials, roleLabel, staffHandle } from '$lib/staff.js';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();

	const avatar = $derived(initials(data.user));
	const userMeta = $derived(`${staffHandle(data.user)} · ${roleLabel(data.user.roles)}`);

	// Only the dashboard exists so far; the other sections are inert until their screens are built.
	const sections = ['Requests', 'Calendar', 'Menu'] as const;
	const onDashboard = $derived(page.url.pathname === '/');

	const pillButton = `inline-flex cursor-pointer items-center justify-center rounded-full border-2 border-transparent bg-olive-700 font-sans text-[11px] leading-[1.4] font-semibold text-cream-200 uppercase transition-colors duration-(--dur-fast) ease-(--ease-out) hover:bg-olive-800 active:translate-y-px ${focusRing}`;
	const menuItem = `flex w-full cursor-pointer items-center gap-2.5 rounded-sm border-0 bg-transparent p-2.5 text-left font-sans text-[13px] leading-[1.4] font-semibold transition-colors duration-(--dur-fast) ease-(--ease-out) ${focusRing}`;
</script>

{#snippet userCard(size: 'sm' | 'md')}
	<div class="flex items-center gap-2.5">
		<span
			aria-hidden="true"
			class={[
				'flex flex-none items-center justify-center rounded-full bg-olive-700 font-sans font-bold text-cream-200',
				size === 'sm' ? 'size-9 text-[13px]' : 'size-[38px] text-sm'
			]}
		>
			{avatar}
		</span>
		<span class="flex min-w-0 flex-col">
			<span
				class={[
					'truncate font-sans leading-[1.4] font-bold text-(--text-heading)',
					size === 'sm' ? 'text-[13px]' : 'text-[13.5px]'
				]}
			>
				{data.user.displayName}
			</span>
			<span
				class={[
					'font-sans leading-[1.4] text-(--text-muted)',
					size === 'sm' ? 'text-[11px]' : 'text-[11.5px]'
				]}
			>
				{userMeta}
			</span>
		</span>
	</div>
{/snippet}

{#snippet accountActions()}
	<button
		disabled
		title="Account settings · Coming next"
		type="button"
		class={`${menuItem} cursor-default text-(--text-muted) opacity-65`}
	>
		<svg
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<circle cx="12" cy="8" r="4"></circle>
			<path d="M4 21c0-4 4-6 8-6s8 2 8 6"></path>
		</svg>
		Account settings
	</button>
	<form method="POST" action={resolve('/logout')}>
		<button type="submit" class={`${menuItem} text-rust-600 hover:bg-rust-600/10`}>
			<svg
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="1.8"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
				<path d="m16 17 5-5-5-5"></path>
				<path d="M21 12H9"></path>
			</svg>
			Sign out
		</button>
	</form>
{/snippet}

<div
	class="flex min-h-dvh flex-col bg-(--surface-page) min-[900px]:h-dvh min-[900px]:flex-row min-[900px]:overflow-hidden"
>
	<!-- Desktop sidebar (≥900px). -->
	<aside
		data-testid="sidebar"
		class="hidden w-[260px] flex-none flex-col gap-1.5 overflow-y-auto border-r border-(--border-soft) bg-(--surface-card) px-4 py-5 min-[900px]:flex"
	>
		<a
			href={resolve('/')}
			aria-label="Dashboard"
			class={`mb-5 flex justify-center rounded-sm px-1 text-olive-900 hover:text-olive-900 ${focusRing}`}
		>
			<Wordmark class="h-[53px]" aria-hidden="true" />
		</a>
		<!-- Future workflows are visibly disabled until their routes exist. -->
		<button
			type="button"
			disabled
			title="New quote · Coming next"
			class={`mx-0.5 mb-3.5 min-h-11 cursor-default px-4 py-[11px] tracking-(--track-caps-tight) opacity-65 ${pillButton}`}
		>
			+ New quote
		</button>
		<nav aria-label="Admin sections" class="flex flex-col gap-1.5">
			<a
				href={resolve('/')}
				aria-current={onDashboard ? 'page' : undefined}
				class={[
					'flex min-h-11 items-center rounded-input px-3.5 py-2.5 font-sans text-xs leading-[1.4] font-semibold tracking-[0.1em] uppercase no-underline transition-colors duration-(--dur-fast) ease-(--ease-out)',
					onDashboard
						? 'bg-olive-700 text-cream-200 hover:text-cream-200'
						: 'text-olive-800 hover:bg-cream-300/60 hover:text-olive-800',
					focusRing
				]}
			>
				Dashboard
			</a>
			{#each sections as section (section)}
				<button
					type="button"
					disabled
					title={`${section} · Coming next`}
					class="flex min-h-11 cursor-default items-center justify-between gap-2 rounded-input border-0 bg-transparent px-3.5 py-2.5 text-left font-sans text-xs leading-[1.4] font-semibold tracking-[0.1em] text-olive-800 uppercase opacity-65"
				>
					{section}
					<span class="text-[9px] tracking-normal normal-case">Coming next</span>
				</button>
			{/each}
		</nav>
		<div class="flex-1"></div>
		<div class="flex flex-col gap-0.5 border-t border-(--border-soft) pt-3.5">
			<div class="px-1 pt-1.5 pb-3">{@render userCard('sm')}</div>
			{@render accountActions()}
		</div>
	</aside>

	<div class="flex min-w-0 flex-1 flex-col min-[900px]:min-h-0">
		<!-- Mobile header (<900px). -->
		<header
			class="sticky top-0 z-10 border-b border-(--border-soft) bg-(--surface-page) min-[900px]:hidden"
		>
			<div class="mx-auto flex max-w-[1200px] items-center gap-4 px-5 py-3">
				<a
					href={resolve('/')}
					aria-label="Dashboard"
					class={`inline-flex rounded-sm text-olive-900 hover:text-olive-900 ${focusRing}`}
				>
					<Wordmark class="h-10" aria-hidden="true" />
				</a>
				<!-- Starts a staff-entered quote later; inert in the scaffold. -->
				<button
					type="button"
					disabled
					title="New quote · Coming next"
					aria-label="New quote"
					class={`ml-auto min-h-10 flex-none cursor-default gap-1.5 px-3.5 py-[9px] tracking-[0.1em] opacity-65 ${pillButton}`}
				>
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M12 5v14M5 12h14"></path>
					</svg>
					Quote
				</button>
				<!-- A native disclosure, so the account menu (and Sign out) works without JavaScript. -->
				<details class="group relative">
					<summary
						aria-label="Your account"
						class={`flex size-10 cursor-pointer list-none items-center justify-center rounded-full border-2 border-olive-300 bg-olive-700 font-sans text-sm font-bold tracking-[0.02em] text-cream-200 group-open:border-cream-200 [&::-webkit-details-marker]:hidden ${focusRing}`}
					>
						{avatar}
					</summary>
					<div
						data-testid="account-menu"
						class="absolute top-[52px] right-0 z-40 flex w-[236px] flex-col gap-0.5 rounded-card border border-(--border-soft) bg-(--surface-card) p-2 shadow-raised"
					>
						<div class="px-2.5 pt-2.5 pb-3">{@render userCard('md')}</div>
						{@render accountActions()}
					</div>
				</details>
			</div>
			<nav
				aria-label="Admin sections"
				class="mx-auto flex max-w-[1200px] flex-wrap gap-2 px-5 pb-3"
			>
				<a
					href={resolve('/')}
					aria-current={onDashboard ? 'page' : undefined}
					class={[
						'inline-flex min-h-11 flex-[1_1_calc(50%-4px)] items-center justify-center rounded-full border-[1.5px] px-2 py-2.5 font-sans text-[11px] leading-[1.4] font-semibold tracking-(--track-caps-tight) uppercase no-underline min-[640px]:basis-0',
						onDashboard
							? 'border-olive-700 bg-olive-700 text-cream-200 hover:text-cream-200'
							: 'border-(--border-soft) text-olive-800 hover:text-olive-800',
						focusRing
					]}
				>
					Dashboard
				</a>
				{#each sections as section (section)}
					<button
						type="button"
						disabled
						title={`${section} · Coming next`}
						class="inline-flex min-h-11 flex-[1_1_calc(50%-4px)] cursor-default flex-col items-center justify-center rounded-full border-[1.5px] border-(--border-soft) bg-transparent px-2 py-2 font-sans text-[11px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-olive-800 uppercase opacity-65 min-[640px]:basis-0"
					>
						{section}
						<span class="text-[9px] tracking-normal normal-case">Coming next</span>
					</button>
				{/each}
			</nav>
		</header>

		<main class="w-full flex-1 px-5 pt-6 min-[900px]:overflow-y-auto min-[1150px]:px-16">
			{@render children()}
		</main>
		<footer class="bg-olive-700 px-4 py-2.5 text-center font-sans text-[11px] text-cream-200">
			admin console
		</footer>
	</div>
</div>
