<script lang="ts">
	import { untrack } from 'svelte';
	import { ChoiceChip, focusRing } from '@fionas/ui';
	import type { OfferingOption } from '@fionas/shared';
	import type { InquiryRequestedPricing, PricingSelection } from '$lib/request-contract.js';
	import type { ServiceConfiguration } from '$lib/quote-contract.js';
	import {
		picksDiff,
		type BuilderChoices,
		type QuoteFieldErrors,
		type ServiceDraft
	} from '$lib/quote-builder.js';
	import { durationLabel, guestCountLabel } from '$lib/presentation.js';
	import { dashedPill, errorText, fieldInput, groupCaps, hint, panelCaps } from './styles.js';

	let {
		choices,
		effective,
		initial,
		reviewed,
		enhanced,
		errors = {},
		feedback = [],
		disabled = false
	}: {
		/** Null when the menu couldn't be loaded: the service is shown but not editable. */
		choices: BuilderChoices | null;
		/** What the reviewed Estimate was priced from; null means the service can't be edited here. */
		effective: InquiryRequestedPricing | null;
		/** Posted values from a failed or previewed native submission. */
		initial: ServiceDraft | null;
		/** The latest preview's service, with the catalog's reviewed names. */
		reviewed: ServiceConfiguration | null;
		enhanced: boolean;
		errors?: QuoteFieldErrors;
		feedback?: string[];
		disabled?: boolean;
	} = $props();

	const editable = $derived(!!choices && !!effective);
	// The editor owns its values once mounted; the server's echo only seeds a fresh render.
	let guestCount = $state(
		untrack(() => initial?.guestCount ?? String(effective?.guestCount ?? ''))
	);
	let guestCountIsMinimum = $state(
		untrack(() => initial?.guestCountIsMinimum ?? effective?.guestCountIsMinimum ?? false)
	);
	let durationMinutes = $state(
		untrack(() => initial?.durationMinutes ?? String(effective?.durationMinutes ?? ''))
	);
	let picks = $state<Record<string, string[]>>(
		untrack(() =>
			Object.fromEntries(
				(initial?.selections ?? effective?.selections ?? []).map((s) => [
					s.category,
					[...s.offerings]
				])
			)
		)
	);
	let open = $state(true);
	let adding = $state<string | null>(null);

	/** Catalog categories in presentation order, plus any recorded category the menu no longer has. */
	const categories = $derived.by(() => {
		const known = choices?.categories ?? [];
		const extra = Object.keys(picks)
			.filter((key) => !known.some((category) => category.key === key) && picks[key].length)
			.map((key) => ({
				key,
				label: reviewedCategoryName(key) ?? key,
				minSelections: 0,
				maxSelections: null,
				options: [] as OfferingOption[]
			}));
		return [...known, ...extra];
	});
	const baseKeys = $derived(
		new Set(
			(effective?.selections ?? []).flatMap((s) =>
				s.offerings.map((o) => `${s.category}\u0000${o}`)
			)
		)
	);
	const selections = $derived<PricingSelection[]>(
		categories.map((category) => ({ category: category.key, offerings: picks[category.key] ?? [] }))
	);
	const diff = $derived(effective ? picksDiff(selections, effective.selections, offeringName) : '');

	function reviewedCategoryName(category: string): string | undefined {
		return reviewed?.selections.find((s) => s.category === category)?.displayName;
	}
	function option(category: string, offering: string): OfferingOption | undefined {
		return choices?.categories
			.find((c) => c.key === category)
			?.options.find((o) => o.key === offering);
	}
	function offeringName(category: string, offering: string): string {
		return (
			option(category, offering)?.displayName ??
			reviewed?.selections
				.find((s) => s.category === category)
				?.offerings.find((o) => o.offering === offering)?.displayName ??
			offering
		);
	}
	function remove(category: string, offering: string) {
		picks[category] = (picks[category] ?? []).filter((key) => key !== offering);
	}
	function add(category: string, offering: string) {
		picks[category] = [...(picks[category] ?? []), offering];
		const limit = categories.find((c) => c.key === category)?.maxSelections;
		if (limit != null && picks[category].length >= limit) adding = null;
	}
	const surface = 'flex flex-col gap-3.5 rounded-input bg-cream-200 p-3.5';
	const chipBase =
		'inline-flex max-w-full items-center gap-1.5 rounded-full border-[1.5px] py-[5px] pr-1.5 pl-3.5 text-xs font-semibold tracking-[0.05em] text-ink-700 wrap-anywhere';
</script>

<section class={surface} aria-labelledby="serve-heading" data-testid="quote-service">
	{#if enhanced}
		<button
			type="button"
			class={`flex items-center gap-2.5 rounded-sm border-0 bg-transparent p-0 text-left ${focusRing}`}
			aria-expanded={open}
			aria-controls="serve-body"
			onclick={() => (open = !open)}
		>
			<span class="flex flex-1 flex-col gap-[3px]">
				<span id="serve-heading" class={panelCaps}>What you’ll serve</span>
				<span class={hint}>
					{editable
						? 'Issuing saves these with the quote as its service plan. Their request stays untouched.'
						: 'The service on their estimate.'}
				</span>
			</span>
			<span
				aria-hidden="true"
				class={[
					'shrink-0 text-[13px] text-(--text-muted) transition-transform duration-(--dur-fast) ease-(--ease-out)',
					!open && '-rotate-90'
				]}>▾</span
			>
		</button>
	{:else}
		<div class="flex flex-col gap-[3px]">
			<h3 id="serve-heading" class={panelCaps}>What you’ll serve</h3>
			<p class={hint}>
				{editable
					? 'Issuing saves these with the quote as its service plan. Their request stays untouched.'
					: 'The service on their estimate.'}
			</p>
		</div>
	{/if}

	<div id="serve-body" hidden={enhanced && !open} class="flex flex-col gap-3.5">
		{#if editable && choices}
			<input type="hidden" name="service" value="1" />
			<input type="hidden" name="catalogRevision" value={choices.catalogRevision} />
			{#each categories as category (category.key)}
				<input type="hidden" name="category" value={category.key} />
			{/each}
			<div class="grid grid-cols-1 gap-3 min-[440px]:grid-cols-[1fr_1.3fr]">
				<label class="flex flex-col gap-1.5">
					<span class={groupCaps}>Guests</span>
					<input
						name="guestCount"
						inputmode="numeric"
						autocomplete="off"
						bind:value={guestCount}
						{disabled}
						aria-invalid={errors.guestCount ? 'true' : undefined}
						aria-describedby={errors.guestCount ? 'guest-count-error' : undefined}
						class={`${fieldInput} w-full text-[15px]`}
					/>
					{#if errors.guestCount}<span id="guest-count-error" class={errorText}
							>{errors.guestCount}</span
						>{/if}
				</label>
				<label class="flex flex-col gap-1.5">
					<span class={groupCaps}>Scooping time</span>
					<select
						name="durationMinutes"
						bind:value={durationMinutes}
						{disabled}
						aria-invalid={errors.durationMinutes ? 'true' : undefined}
						class={`${fieldInput} w-full text-[15px]`}
					>
						{#each choices.durations as duration (duration.value)}
							<option value={String(duration.value)}>{duration.label}</option>
						{/each}
						{#if durationMinutes && !choices.durations.some((d) => String(d.value) === durationMinutes)}
							<option value={durationMinutes}>{durationLabel(Number(durationMinutes))}</option>
						{/if}
					</select>
				</label>
			</div>
			<label class="-mt-1 flex items-center gap-2 text-xs text-ink-700">
				<input
					type="checkbox"
					name="guestCountIsMinimum"
					bind:checked={guestCountIsMinimum}
					{disabled}
					class={`accent-olive-700 ${focusRing}`}
				/>
				Guest count is a minimum
			</label>

			{#each categories as category (category.key)}
				{@const selected = picks[category.key] ?? []}
				{@const full = category.maxSelections != null && selected.length >= category.maxSelections}
				{@const remaining = category.options.filter((o) => !selected.includes(o.key))}
				<div class="flex flex-col gap-2" data-testid={`pick-group-${category.key}`}>
					<span id={`pick-label-${category.key}`} class={groupCaps}
						>{category.label}{category.maxSelections != null
							? ` · ${selected.length} of ${category.maxSelections === category.minSelections ? '' : 'up to '}${category.maxSelections}`
							: ''}</span
					>
					{#if enhanced}
						<ul
							class="m-0 flex list-none flex-wrap gap-2 p-0"
							aria-labelledby={`pick-label-${category.key}`}
						>
							{#each selected as key (key)}
								{@const known = option(category.key, key)}
								{@const original = baseKeys.has(`${category.key}\u0000${key}`)}
								<li
									class={[
										chipBase,
										original ? 'border-olive-300 bg-cream-200' : 'border-moss-600 bg-moss-600/15',
										(!known || known.availability === 'UNAVAILABLE') && 'border-dashed'
									]}
								>
									<input type="hidden" name={`pick:${category.key}`} value={key} />
									<span>{offeringName(category.key, key)}</span>
									{#if !known}<span class="text-[10px] font-medium text-rust-600"
											>· not on the menu</span
										>{:else if known.availability === 'UNAVAILABLE'}<span
											class="text-[10px] font-medium text-rust-600">· unavailable</span
										>{/if}
									<button
										type="button"
										aria-label={`Remove ${offeringName(category.key, key)}`}
										{disabled}
										onclick={() => remove(category.key, key)}
										class={`inline-flex size-[22px] shrink-0 items-center justify-center rounded-full border-0 bg-ink-700/10 text-[13px] leading-none text-(--text-muted) transition-colors duration-(--dur-fast) ease-(--ease-out) hover:bg-rust-600 hover:text-cream-100 ${focusRing}`}
										>×</button
									>
								</li>
							{:else}
								<li class="py-1.5 text-xs text-(--text-muted)">Nothing selected.</li>
							{/each}
							{#if !full && remaining.length && adding !== category.key}
								<li>
									<button
										type="button"
										class={dashedPill}
										{disabled}
										aria-label={`Add to ${category.label}`}
										onclick={() => (adding = category.key)}>+ Add</button
									>
								</li>
							{/if}
						</ul>
						{#if adding === category.key}
							<div
								class="flex flex-col gap-2.5 rounded-input border border-(--border-soft) bg-cream-100 p-3"
							>
								<div class="flex flex-wrap gap-2">
									{#each remaining as offering (offering.key)}
										<button
											type="button"
											disabled={disabled || offering.availability !== 'AVAILABLE' || full}
											title={offering.availability !== 'AVAILABLE'
												? (offering.statusNote ?? 'Unavailable right now')
												: undefined}
											onclick={() => add(category.key, offering.key)}
											class={`inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-(--border-soft) bg-cream-200 px-3.5 py-1.5 text-xs font-semibold tracking-[0.05em] text-ink-700 transition-[border-color] duration-(--dur-fast) ease-(--ease-out) not-disabled:hover:border-olive-700 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`}
										>
											{offering.displayName}
											{#if offering.badge}<span class="text-[9px] font-medium uppercase"
													>· {offering.badge}</span
												>{/if}
										</button>
									{/each}
								</div>
								<button
									type="button"
									onclick={() => (adding = null)}
									class={`self-start ${dashedPill} border-solid`}>Done</button
								>
							</div>
						{/if}
					{:else}
						<div
							class="flex flex-wrap gap-2"
							role="group"
							aria-labelledby={`pick-label-${category.key}`}
						>
							{#each [...selected.filter((key) => !option(category.key, key)), ...category.options.map((o) => o.key)] as key (key)}
								{@const known = option(category.key, key)}
								{@const checked = selected.includes(key)}
								<ChoiceChip
									name={`pick:${category.key}`}
									value={key}
									label={offeringName(category.key, key)}
									badge={known?.badge ?? (known ? undefined : 'Not on the menu')}
									{checked}
									unavailable={!known || known.availability !== 'AVAILABLE'}
									disabled={disabled || (!checked && known?.availability !== 'AVAILABLE')}
								/>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
			{#if diff}
				<p
					class="m-0 border-t border-(--border-soft) pt-2.5 text-[11.5px] leading-[1.6] text-(--text-muted)"
				>
					{diff}
				</p>
			{/if}
		{:else}
			{#if reviewed}
				<p class="m-0 text-sm font-semibold">
					{guestCountLabel(reviewed.guestCount, reviewed.guestCountIsMinimum)} · {durationLabel(
						reviewed.durationMinutes
					)}
				</p>
				{#each reviewed.selections as category (category.category)}
					<div class="flex flex-col gap-2">
						<span class={groupCaps}>{category.displayName}</span>
						<ul class="m-0 flex list-none flex-wrap gap-2 p-0">
							{#each category.offerings as offering (offering.offering)}
								<li class={`${chipBase} border-olive-300 bg-cream-200 pr-3.5`}>
									{offering.displayName}
								</li>
							{/each}
						</ul>
					</div>
				{/each}
			{/if}
			<p class={hint} role="note">
				{effective
					? 'The menu couldn’t be loaded, so picks, guests and scooping time can’t be changed right now. You can still adjust lines and the deposit.'
					: 'This estimate’s service can’t be changed here. You can still adjust lines and the deposit.'}
			</p>
		{/if}
		{#each feedback as text (text)}
			<p class={errorText} role="alert">{text}</p>
		{/each}
	</div>
</section>
