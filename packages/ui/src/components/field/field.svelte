<script lang="ts" module>
	export type FieldControlProps = {
		id: string;
		describedby: string | undefined;
		invalid: boolean;
	};
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../utils.js';
	import { capsXs, hintText } from '../../styles.js';

	/**
	 * Small-caps label, the control, then a hint and any error beneath it. Single controls get a
	 * `<label for>`; choice groups (`group`) use `role="group"` and can show a live `meta` note
	 * beside the label (e.g. "1 of 2 picked"). The control receives the ids it needs as snippet
	 * arguments so `aria-describedby` and `aria-invalid` stay wired up.
	 */
	let {
		label,
		description,
		error,
		meta,
		required = false,
		group = false,
		id,
		class: className,
		children
	}: {
		label: string;
		description?: string;
		error?: string;
		meta?: string;
		required?: boolean;
		group?: boolean;
		id?: string;
		class?: string;
		children: Snippet<[FieldControlProps]>;
	} = $props();

	const uid = $props.id();
	const controlId = $derived(id ?? `field-${uid}`);
	const labelId = $derived(`${controlId}-label`);
	const descriptionId = $derived(`${controlId}-description`);
	const errorId = $derived(`${controlId}-error`);
	const describedby = $derived(
		[description ? descriptionId : null, error ? errorId : null].filter(Boolean).join(' ') ||
			undefined
	);

	const labelClass = cn(capsXs, 'text-(--text-heading)');
</script>

{#snippet requiredMark()}
	{#if required}<span class="text-rust-600" aria-hidden="true"> *</span>{/if}
{/snippet}

{#snippet details()}
	{#if description}
		<p id={descriptionId} class={cn(hintText, 'm-0')}>
			{description}
		</p>
	{/if}
	{#if error}
		<p id={errorId} class="m-0 font-sans text-xs leading-[1.45] font-medium text-rust-600">
			{error}
		</p>
	{/if}
{/snippet}

{#if group}
	<div
		role="group"
		data-slot="field"
		data-invalid={error ? '' : undefined}
		class={cn('flex min-w-0 flex-col gap-2.5', className)}
		aria-labelledby={labelId}
		aria-describedby={describedby}
	>
		<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
			<span id={labelId} class={labelClass}>{label}{@render requiredMark()}</span>
			{#if meta}
				<span aria-live="polite" class={hintText}>{meta}</span>
			{/if}
		</div>
		{@render children({ id: controlId, describedby, invalid: !!error })}
		{@render details()}
	</div>
{:else}
	<div
		data-slot="field"
		data-invalid={error ? '' : undefined}
		class={cn('flex min-w-0 flex-col gap-1.5', className)}
	>
		<label for={controlId} class={labelClass}>{label}{@render requiredMark()}</label>
		{@render children({ id: controlId, describedby, invalid: !!error })}
		{@render details()}
	</div>
{/if}
