<script lang="ts">
	import { onMount } from 'svelte';
	import { capsSm, cn, focusRing, hintText } from '@fionas/ui';
	import type { InquiryFormField } from '@fionas/shared';

	/**
	 * "About how many guests?" from the Booking design: a numeric field in a pill between −/+
	 * buttons, quick-pick presets and one live help line. Arrow keys nudge by one (Shift by 25);
	 * −/+ snap to the step. A count above the maximum isn't trimmed: the customer sees the limit
	 * and sending is refused until it is within it. The buttons and presets need JavaScript, so they
	 * appear after hydration; without it the plain input submits as `name` = field key.
	 */
	let {
		field,
		value,
		error,
		onchange,
		class: className
	}: {
		field: InquiryFormField;
		value: string;
		error?: string;
		onchange: (value: string) => void;
		class?: string;
	} = $props();

	const uid = $props.id();
	const inputId = `guests-${uid}`;
	const helpId = `guests-${uid}-help`;

	let hydrated = $state(false);
	onMount(() => (hydrated = true));

	const maximum = $derived(field.input.type === 'INTEGER' ? (field.input.maximum ?? 9999) : 9999);
	const step = $derived(field.presentation.step ?? 1);
	const presets = $derived(field.presentation.presets ?? []);
	const messages = $derived(field.presentation.messages ?? {});
	const count = $derived(/^\d+$/.test(value) ? Number(value) : 0);

	/** Over the limit is said at once; anything else waits for the form's own validation. */
	const problem = $derived(count > maximum ? messages.aboveMaximum : error);
	const help = $derived(
		problem ?? (count < 1 ? messages.belowMinimum : undefined) ?? field.description
	);

	const set = (n: number) => onchange(String(Math.min(maximum, Math.max(0, n))));
	const up = () => set(Math.floor(count / step) * step + step);
	const down = () => set(Math.ceil(count / step) * step - step);

	function keydown(event: KeyboardEvent) {
		if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
		event.preventDefault();
		const by = event.shiftKey ? 25 : 1;
		set(count + (event.key === 'ArrowUp' ? by : -by));
	}

	const stepButton = cn(
		'inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border-0',
		'bg-olive-700 font-sans text-xl leading-none font-semibold text-cream-200',
		'transition-[background-color,opacity] duration-(--dur-fast) ease-(--ease-out) hover:bg-olive-800',
		'disabled:cursor-not-allowed disabled:bg-transparent disabled:text-(--text-muted) disabled:opacity-40',
		focusRing
	);
</script>

<div
	data-slot="field"
	data-invalid={problem ? '' : undefined}
	class={cn('flex min-w-0 flex-col gap-2.5', className)}
>
	<label for={inputId} class={cn(capsSm, 'text-(--text-heading)')}>{field.label}</label>
	<div class="flex flex-wrap items-center gap-3.5">
		<div
			role="group"
			aria-label="Guest count"
			class={cn(
				'inline-flex items-center rounded-full border-[1.5px] border-olive-300/70 bg-cream-100 p-1',
				'has-[input:focus-visible]:outline-[3px] has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-(--focus-ring)',
				problem && 'border-rust-600'
			)}
		>
			{#if hydrated}
				<button
					type="button"
					aria-label="{step} fewer guests"
					class={stepButton}
					disabled={count <= 0}
					onclick={down}>−</button
				>
			{/if}
			<input
				id={inputId}
				name={field.key}
				type="text"
				inputmode="numeric"
				autocomplete="off"
				maxlength="4"
				{value}
				aria-describedby={helpId}
				aria-invalid={problem ? true : undefined}
				aria-required={field.required || undefined}
				oninput={(e) => onchange(e.currentTarget.value.replace(/\D/g, '').slice(0, 4))}
				onkeydown={keydown}
				class="w-16 border-0 bg-transparent py-1 text-center font-sans text-xl font-bold text-(--text-heading) outline-none"
			/>
			{#if hydrated}
				<button
					type="button"
					aria-label="{step} more guests"
					class={stepButton}
					disabled={count >= maximum}
					onclick={up}>+</button
				>
			{/if}
		</div>
		{#if hydrated && presets.length}
			<div class="flex flex-wrap gap-2">
				{#each presets as preset (preset)}
					<button
						type="button"
						aria-pressed={count === preset}
						aria-label="{preset} guests"
						onclick={() => set(preset)}
						class={cn(
							'inline-flex cursor-pointer items-center rounded-full border-[1.5px] px-3.5 py-[7px]',
							'font-sans text-xs font-semibold tracking-[0.05em]',
							'transition-[background-color,border-color,color] duration-(--dur-fast) ease-(--ease-out)',
							'border-olive-300/70 bg-cream-100 text-ink-700 hover:border-olive-500',
							'aria-pressed:border-olive-700 aria-pressed:bg-olive-700 aria-pressed:text-cream-200',
							focusRing
						)}>{preset}</button
					>
				{/each}
			</div>
		{/if}
	</div>
	<p
		id={helpId}
		aria-live="polite"
		class={cn(hintText, 'm-0', problem && 'font-medium text-rust-600')}
	>
		{help}
	</p>
</div>
