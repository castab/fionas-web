<script lang="ts">
	import { Checkbox, ChoiceChip, Field, Input, Select, Textarea, cn, hintText } from '@fionas/ui';
	import {
		formatOfferingPrice,
		isDigitsOnly,
		isSelectable,
		type AnswerValue,
		type InquiryFormField,
		type InquiryPricingPreview,
		type OfferingOption
	} from '@fionas/shared';
	import type { FieldNote } from '$lib/booking-copy.js';
	import GuestStepper from './guest-stepper.svelte';

	/**
	 * Renders one code-owned question. The control follows `presentation.control`
	 * (short choice lists become chips); `input` supplies the constraints. Field `name` is the field
	 * key so the plain HTML form submits without JavaScript. As in the Booking design, required
	 * questions carry no asterisk (nearly all are required); controls say so with `aria-required`,
	 * and choice groups with their "pick" wording and counter. `note` is a live line under chips.
	 */
	let {
		field,
		values = $bindable(),
		error,
		preview,
		note,
		class: className
	}: {
		field: InquiryFormField;
		values: Record<string, AnswerValue>;
		error?: string;
		preview?: InquiryPricingPreview;
		note?: FieldNote;
		class?: string;
	} = $props();

	/** Up to this many options read better as chips than as a dropdown. */
	const MAX_CHIP_OPTIONS = 6;

	const input = $derived(field.input);
	const control = $derived(field.presentation.control);

	const text = $derived(typeof values[field.key] === 'string' ? (values[field.key] as string) : '');
	const picked = $derived(
		Array.isArray(values[field.key]) ? (values[field.key] as string[]) : ([] as string[])
	);

	const setText = (value: string) => (values[field.key] = value);
	const placeholder = $derived(field.presentation.placeholder);

	function toggle(option: OfferingOption, checked: boolean, single: boolean) {
		if (single) values[field.key] = [option.key];
		else
			values[field.key] = checked
				? [...picked, option.key]
				: picked.filter((key) => key !== option.key);
	}

	/** "1 of 2 picked" style note shown beside the label of multi-select groups. */
	const counter = $derived.by(() => {
		if (input.type !== 'OFFERING_CHOICE' || input.maxSelections === 1) return undefined;
		const { minSelections: min, maxSelections: max, category } = input;
		const included = preview?.toppingAdjustment;
		if (included && included.category === category && max !== undefined) {
			return `${picked.length} picked · ${included.includedSelections} included, up to ${max}`;
		}
		if (max === undefined) return `${picked.length} picked`;
		if (min === max) return `${picked.length} of ${max} picked`;
		return `${picked.length} picked · choose ${min}–${max}`;
	});

	/**
	 * Field description plus, for the topping category, what the price adjustment means, and a
	 * heads-up when too few options are available right now to meet the minimum.
	 */
	const hint = $derived.by(() => {
		if (input.type !== 'OFFERING_CHOICE') return field.description;
		const extra =
			preview?.toppingAdjustment.category === input.category &&
			input.maxSelections !== undefined &&
			input.maxSelections > preview.toppingAdjustment.includedSelections
				? `First ${preview.toppingAdjustment.includedSelections} are included — each extra adds a little per guest.`
				: undefined;
		const selectable = input.options.filter(isSelectable).length;
		const short =
			selectable < input.minSelections
				? `Only ${selectable} ${selectable === 1 ? 'is' : 'are'} available right now, so this can't be completed online today. Please check back later or email us.`
				: undefined;
		return [field.description, extra, short].filter(Boolean).join(' ') || undefined;
	});

	/** Browser autofill hints for the common contact questions. */
	function autocompleteFor(key: string, type: string) {
		if (type === 'EMAIL') return 'email';
		if (key === 'name') return 'name';
		if (key === 'zipCode') return 'postal-code';
		return undefined;
	}

	const atMax = $derived(
		input.type === 'OFFERING_CHOICE' &&
			input.maxSelections !== undefined &&
			picked.length >= input.maxSelections
	);
</script>

{#if control === 'STEPPER' && input.type === 'INTEGER'}
	<GuestStepper class={className} {field} value={text} {error} onchange={setText} />
{:else if control === 'CHECKBOX' && input.type === 'BOOLEAN'}
	<Checkbox
		class={className}
		name={field.key}
		description={field.description}
		bind:checked={() => values[field.key] === true, (checked) => (values[field.key] = checked)}
	>
		{field.label}
	</Checkbox>
{:else if input.type === 'OFFERING_CHOICE'}
	{@const single = input.maxSelections === 1}
	<Field
		class={className}
		label={field.label}
		meta={counter}
		description={hint}
		{error}
		group
		labelTone="heading"
	>
		<div class="flex flex-wrap gap-2">
			{#each input.options as option (option.key)}
				{@const checked = picked.includes(option.key)}
				{@const unavailable = !isSelectable(option)}
				<!-- An unavailable choice stays listed (it is only temporarily out) but can't be picked.
				     One still checked from older answers stays enabled so it can be unchecked. -->
				<ChoiceChip
					type={single ? 'radio' : 'checkbox'}
					name={field.key}
					value={option.key}
					{checked}
					{unavailable}
					disabled={!checked && (unavailable || (atMax && !single))}
					label={option.displayName}
					meta={option.price ? formatOfferingPrice(option.price) : undefined}
					badge={option.badge ?? undefined}
					statusNote={option.statusNote ?? undefined}
					infoNote={option.infoNote ?? undefined}
					title={option.description ?? undefined}
					onchange={(e) => toggle(option, e.currentTarget.checked, single)}
				/>
			{/each}
		</div>
		{#if note}
			<p
				aria-live="polite"
				class={cn(hintText, 'm-0', note.done && 'text-moss-600')}
				data-done={note.done ? '' : undefined}
			>
				{note.text}
			</p>
		{/if}
	</Field>
{:else if (input.type === 'INTEGER_CHOICE' || input.type === 'STRING_CHOICE') && (control === 'CHIPS' || (input.type === 'INTEGER_CHOICE' && input.options.length <= MAX_CHIP_OPTIONS))}
	<Field
		class={className}
		label={field.label}
		description={field.description}
		{error}
		group
		labelTone="heading"
	>
		<div class="flex flex-wrap gap-2">
			{#each input.options as option (option.value)}
				<ChoiceChip
					type="radio"
					name={field.key}
					value={String(option.value)}
					checked={text === String(option.value)}
					label={option.label}
					badge={option.badge}
					statusNote={option.statusNote}
					infoNote={option.infoNote}
					onchange={() => setText(String(option.value))}
				/>
			{/each}
		</div>
	</Field>
{:else}
	<Field class={className} label={field.label} description={field.description} {error}>
		{#snippet children({ id, describedby, invalid })}
			{#if control === 'TEXTAREA' && input.type === 'TEXT'}
				<Textarea
					{id}
					name={field.key}
					value={text}
					oninput={(e) => setText(e.currentTarget.value)}
					maxlength={input.maxLength}
					placeholder={placeholder ??
						'Parking notes, timing, favorite flavors we should know about…'}
					aria-describedby={describedby}
					aria-invalid={invalid}
					aria-required={field.required || undefined}
				/>
			{:else if input.type === 'DATE'}
				<Input
					{id}
					name={field.key}
					type="date"
					value={text}
					oninput={(e) => setText(e.currentTarget.value)}
					aria-describedby={describedby}
					aria-invalid={invalid}
					aria-required={field.required || undefined}
				/>
			{:else if input.type === 'INTEGER_CHOICE' || input.type === 'STRING_CHOICE'}
				{@const options =
					input.type === 'INTEGER_CHOICE'
						? input.options.map((o) => ({ value: String(o.value), label: o.label }))
						: input.options}
				<Select
					{id}
					name={field.key}
					value={text}
					onchange={(e) => setText(e.currentTarget.value)}
					aria-describedby={describedby}
					aria-invalid={invalid}
					aria-required={field.required || undefined}
				>
					<option value="">Pick one</option>
					{#each options as option (option.value)}
						<option value={option.value}>{option.label}</option>
					{/each}
				</Select>
			{:else if control === 'NUMBER' && input.type === 'INTEGER'}
				<Input
					{id}
					name={field.key}
					type="number"
					inputmode="numeric"
					min={input.minimum}
					step="1"
					{placeholder}
					value={text}
					oninput={(e) => setText(e.currentTarget.value)}
					aria-describedby={describedby}
					aria-invalid={invalid}
					aria-required={field.required || undefined}
				/>
			{:else}
				<Input
					{id}
					name={field.key}
					type={input.type === 'EMAIL' ? 'email' : 'text'}
					autocomplete={autocompleteFor(field.key, input.type)}
					inputmode={input.type === 'TEXT' && input.pattern && isDigitsOnly(input.pattern)
						? 'numeric'
						: undefined}
					placeholder={placeholder ?? (input.type === 'EMAIL' ? 'you@example.com' : undefined)}
					maxlength={input.type === 'TEXT' || input.type === 'EMAIL' ? input.maxLength : undefined}
					value={text}
					oninput={(e) => setText(e.currentTarget.value)}
					aria-describedby={describedby}
					aria-invalid={invalid}
					aria-required={field.required || undefined}
				/>
			{/if}
		{/snippet}
	</Field>
{/if}
