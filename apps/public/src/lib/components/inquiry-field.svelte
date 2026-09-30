<script lang="ts">
	import { Checkbox, ChoiceChip, Field, Input, Select, Textarea } from '@fionas/ui';
	import {
		formatOfferingPrice,
		isDigitsOnly,
		type AnswerValue,
		type InquiryFormField,
		type InquiryPricingPreview,
		type OfferingOption
	} from '@fionas/shared';

	/**
	 * Renders one question from GET /inquiry-form. The control follows `presentation.control`
	 * (short choice lists become chips); `input` supplies the constraints. Field `name` is the field
	 * key so the plain HTML form submits without JavaScript.
	 */
	let {
		field,
		values = $bindable(),
		error,
		preview,
		class: className
	}: {
		field: InquiryFormField;
		values: Record<string, AnswerValue>;
		error?: string;
		preview?: InquiryPricingPreview;
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

	/** Field description plus, for the topping category, what the price adjustment means. */
	const hint = $derived.by(() => {
		const extra =
			input.type === 'OFFERING_CHOICE' &&
			preview?.toppingAdjustment.category === input.category &&
			input.maxSelections !== undefined &&
			input.maxSelections > preview.toppingAdjustment.includedSelections
				? `First ${preview.toppingAdjustment.includedSelections} are included — each extra adds a little per guest.`
				: undefined;
		return [field.description, extra].filter(Boolean).join(' ') || undefined;
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

{#if control === 'CHECKBOX' && input.type === 'BOOLEAN'}
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
		required={field.required}
		group
	>
		<div class="flex flex-wrap gap-2">
			{#each input.options as option (option.key)}
				{@const checked = picked.includes(option.key)}
				<ChoiceChip
					type={single ? 'radio' : 'checkbox'}
					name={field.key}
					value={option.key}
					{checked}
					disabled={!checked && atMax && !single}
					label={option.displayName}
					meta={option.price ? formatOfferingPrice(option.price) : undefined}
					title={option.description ?? undefined}
					onchange={(e) => toggle(option, e.currentTarget.checked, single)}
				/>
			{/each}
		</div>
	</Field>
{:else if input.type === 'INTEGER_CHOICE' && input.options.length <= MAX_CHIP_OPTIONS}
	<Field
		class={className}
		label={field.label}
		description={field.description}
		{error}
		required={field.required}
		group
	>
		<div class="flex flex-wrap gap-2">
			{#each input.options as option (option.value)}
				<ChoiceChip
					type="radio"
					name={field.key}
					value={String(option.value)}
					checked={text === String(option.value)}
					label={option.label}
					onchange={() => setText(String(option.value))}
				/>
			{/each}
		</div>
	</Field>
{:else}
	<Field
		class={className}
		label={field.label}
		description={field.description}
		{error}
		required={field.required}
	>
		{#snippet children({ id, describedby, invalid })}
			{#if control === 'TEXTAREA' && input.type === 'TEXT'}
				<Textarea
					{id}
					name={field.key}
					value={text}
					oninput={(e) => setText(e.currentTarget.value)}
					maxlength={input.maxLength}
					placeholder="Parking notes, timing, favorite flavors we should know about…"
					aria-describedby={describedby}
					aria-invalid={invalid}
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
					value={text}
					oninput={(e) => setText(e.currentTarget.value)}
					aria-describedby={describedby}
					aria-invalid={invalid}
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
					placeholder={input.type === 'EMAIL' ? 'you@example.com' : undefined}
					maxlength={input.type === 'TEXT' || input.type === 'EMAIL' ? input.maxLength : undefined}
					value={text}
					oninput={(e) => setText(e.currentTarget.value)}
					aria-describedby={describedby}
					aria-invalid={invalid}
				/>
			{/if}
		{/snippet}
	</Field>
{/if}
