<script lang="ts">
	import { focusRing } from '@fionas/ui';
	import type { QuotePreviewLine } from '$lib/quote-contract.js';
	import {
		adjustmentKindLabel,
		adjustmentKinds,
		isActiveOverride,
		lineTarget,
		overrideOriginalLabel,
		targetKey,
		type AdjustmentDraft,
		type QuoteFieldErrors
	} from '$lib/quote-builder.js';
	import { formatMoney } from '$lib/presentation.js';
	import { moneyMinorUnits } from '$lib/payments.js';
	import { dashedPill, errorText, fieldInput, fieldSurface, roundIconButton } from './styles.js';

	let {
		lines,
		adjustmentLines,
		overrides = $bindable(),
		adjustments = $bindable(),
		currency,
		enhanced,
		errors = {},
		lineFeedback = [],
		adjustmentFeedback = [],
		disabled = false,
		newKey
	}: {
		/** Service lines from the latest preview (or the Estimate before one), in order. */
		lines: QuotePreviewLine[];
		/** Previewed added lines, matched to rows by clientKey for their signed amount. */
		adjustmentLines: QuotePreviewLine[];
		overrides: Record<string, { amount: string; reason: string }>;
		adjustments: AdjustmentDraft[];
		currency: string;
		enhanced: boolean;
		errors?: QuoteFieldErrors;
		lineFeedback?: string[];
		adjustmentFeedback?: string[];
		disabled?: boolean;
		newKey: () => string;
	} = $props();

	/** Without JavaScript the form always carries one blank added line to fill in. */
	const blankKey = $derived.by(() => {
		let index = adjustments.length + 1;
		while (adjustments.some((row) => row.clientKey === `line-${index}`)) index++;
		return `line-${index}`;
	});
	const rows = $derived(
		enhanced
			? adjustments
			: [
					...adjustments,
					{
						clientKey: blankKey,
						kind: 'CHARGE' as const,
						description: '',
						detail: '',
						amount: '',
						reason: ''
					}
				]
	);

	function original(line: QuotePreviewLine): string {
		return line.override?.originalTotal ?? line.total;
	}
	function amountFor(key: string, line: QuotePreviewLine): string {
		return overrides[key]?.amount ?? line.total;
	}
	function setAmount(key: string, line: QuotePreviewLine, amount: string) {
		overrides[key] = { amount, reason: overrides[key]?.reason ?? line.override?.reason ?? '' };
	}
	function active(key: string, line: QuotePreviewLine): boolean {
		return isActiveOverride(
			{ key, amount: amountFor(key, line), original: original(line), reason: '' },
			currency
		);
	}
	function detail(line: QuotePreviewLine): string {
		if (line.subDescription) return line.subDescription;
		if (line.override) return '';
		return line.quantity !== undefined
			? `${line.quantity} × ${formatMoney(line.unitPrice, currency)}`
			: 'Flat charge';
	}
	function previewed(clientKey: string): QuotePreviewLine | undefined {
		return adjustmentLines.find(
			(line) => line.origin.type === 'ADJUSTMENT' && line.origin.clientKey === clientKey
		);
	}
	/**
	 * The line as staff typed it, shown at once: the entered amount with its kind's sign. It's the
	 * input echoed back, not arithmetic; totals and deposits only ever come from the preview.
	 */
	function echo(row: AdjustmentDraft): string | null {
		const amount = row.amount.trim();
		const minor = moneyMinorUnits(amount, currency);
		if (minor === null || minor <= 0n) {
			const line = previewed(row.clientKey);
			return line ? formatMoney(line.total, currency) : null;
		}
		return `${row.kind === 'CHARGE' ? '' : '-'}${formatMoney(amount, currency)}`;
	}
	function removeAdjustment(clientKey: string) {
		adjustments = adjustments.filter((row) => row.clientKey !== clientKey);
	}
	function addAdjustment() {
		adjustments = [
			...adjustments,
			{ clientKey: newKey(), kind: 'CHARGE', description: '', detail: '', amount: '', reason: '' }
		];
	}
	const money = `${fieldSurface} flex shrink-0 items-center gap-1 px-3 py-2.5 transition-[border-color] duration-(--dur-fast) ease-(--ease-out) hover:border-olive-500 has-[input:focus-visible]:outline-[3px] has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-(--focus-ring) has-[input[aria-invalid=true]]:border-rust-600`;
	const moneyInput =
		'w-16 border-0 bg-transparent p-0 text-right text-sm font-semibold text-ink-700 outline-none';
</script>

<div class="flex flex-col gap-2.5" data-testid="quote-lines">
	<ul class="m-0 flex list-none flex-col gap-2.5 p-0" aria-label="Quote lines">
		{#each lines as line, index (line.lineItemId ?? `${index}:${line.description}`)}
			{@const target = lineTarget(line)}
			{@const key = target ? targetKey(target) : null}
			<li class="flex flex-col gap-1" data-testid="quote-line">
				<div class="flex items-center gap-2">
					<span
						class={`${fieldSurface} min-w-0 flex-1 truncate px-3 py-2.5 text-sm font-semibold text-ink-700`}
						>{line.description}</span
					>
					{#if key}
						{@const changed = active(key, line)}
						<label class={money}>
							<span class="text-sm text-(--text-muted)" aria-hidden="true">$</span>
							<span class="sr-only">Amount for {line.description}</span>
							<input
								name={`override:amount:${key}`}
								inputmode="decimal"
								autocomplete="off"
								value={amountFor(key, line)}
								oninput={(event) => setAmount(key, line, event.currentTarget.value)}
								{disabled}
								aria-invalid={errors[`override:amount:${key}`] ? 'true' : undefined}
								class={moneyInput}
							/>
						</label>
						<input type="hidden" name={`override:original:${key}`} value={original(line)} />
						{#if enhanced}
							<button
								type="button"
								class={`${roundIconButton} size-[34px] text-base`}
								aria-label={`Restore the original price of ${line.description}`}
								title="Restore original price"
								disabled={disabled || !changed}
								onclick={() => delete overrides[key]}>↺</button
							>
						{/if}
					{:else}
						<span class={`${fieldSurface} px-3 py-2.5 text-sm font-semibold`}
							>{formatMoney(line.total, currency)}</span
						>
					{/if}
				</div>
				<span class={`${fieldSurface} px-3 py-2 text-[11.5px] text-(--text-muted)`}>
					{detail(line)}{#if line.override}<span
							class={['block font-semibold text-olive-800', detail(line) && 'mt-0.5']}
							>{overrideOriginalLabel(line)}</span
						>{/if}
				</span>
				{#if key && active(key, line)}
					<label class="flex flex-col gap-1">
						<span class="sr-only">Why the price of {line.description} changed</span>
						<input
							name={`override:reason:${key}`}
							value={overrides[key]?.reason ?? line.override?.reason ?? ''}
							oninput={(event) =>
								(overrides[key] = {
									amount: amountFor(key, line),
									reason: event.currentTarget.value
								})}
							maxlength="500"
							placeholder="Why the price changed — e.g. negotiated package rate"
							{disabled}
							aria-invalid={errors[`override:reason:${key}`] ? 'true' : undefined}
							class={`${fieldInput} text-xs`}
						/>
					</label>
				{/if}
				{#each [`override:amount:${key}`, `override:reason:${key}`] as field (field)}
					{#if key && errors[field]}<span class={errorText}>{errors[field]}</span>{/if}
				{/each}
			</li>
		{/each}

		{#each rows as row (row.clientKey)}
			{@const key = row.clientKey}
			<li class="flex flex-col gap-1" data-testid="quote-adjustment">
				<input type="hidden" name="adjustment" value={key} />
				<div class="flex items-center gap-2">
					<input
						name={`adjustment:description:${key}`}
						bind:value={row.description}
						maxlength="120"
						placeholder="Line name — e.g. Additional travel fee"
						aria-label="Added line name"
						{disabled}
						aria-invalid={errors[`adjustment:description:${key}`] ? 'true' : undefined}
						class={`${fieldInput} flex-1 font-semibold`}
					/>
					<label class={money}>
						<span class="text-sm text-(--text-muted)" aria-hidden="true">$</span>
						<span class="sr-only">Added line amount</span>
						<input
							name={`adjustment:amount:${key}`}
							inputmode="decimal"
							autocomplete="off"
							bind:value={row.amount}
							{disabled}
							aria-invalid={errors[`adjustment:amount:${key}`] ? 'true' : undefined}
							class={moneyInput}
						/>
					</label>
					{#if enhanced}
						<button
							type="button"
							class={`${roundIconButton} size-[34px] text-base`}
							aria-label="Remove added line"
							{disabled}
							onclick={() => removeAdjustment(key)}>×</button
						>
					{/if}
				</div>
				<fieldset class="m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0" {disabled}>
					<legend class="sr-only">Kind of added line</legend>
					{#each adjustmentKinds as kind (kind)}
						<label
							class={`relative inline-flex cursor-pointer items-center rounded-full border-[1.5px] px-3 py-1 text-[11px] font-semibold tracking-[0.05em] transition-colors duration-(--dur-fast) ease-(--ease-out) has-checked:border-olive-700 has-checked:bg-olive-700 has-checked:text-cream-200 has-[input:focus-visible]:outline-[3px] has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-(--focus-ring) ${row.kind === kind ? '' : 'border-(--border-soft) text-ink-700'}`}
						>
							<input
								type="radio"
								name={`adjustment:kind:${key}`}
								value={kind}
								bind:group={row.kind}
								class={`absolute inset-0 size-full cursor-pointer opacity-0 ${focusRing}`}
							/>
							{adjustmentKindLabel(kind)}
						</label>
					{/each}
					{#if echo(row)}
						<span class="ml-auto text-xs font-semibold text-olive-800">{echo(row)}</span>
					{/if}
				</fieldset>
				<input
					name={`adjustment:detail:${key}`}
					bind:value={row.detail}
					maxlength="240"
					placeholder="Optional detail — shown under the line"
					aria-label="Added line detail"
					{disabled}
					aria-invalid={errors[`adjustment:detail:${key}`] ? 'true' : undefined}
					class={`${fieldInput} py-2 text-[11.5px] text-(--text-muted)`}
				/>
				<input
					name={`adjustment:reason:${key}`}
					bind:value={row.reason}
					maxlength="500"
					placeholder="Why it’s added — staff only"
					aria-label="Why this line is added"
					{disabled}
					aria-invalid={errors[`adjustment:reason:${key}`] ? 'true' : undefined}
					class={`${fieldInput} py-2 text-xs`}
				/>
				{#each ['description', 'amount', 'detail', 'reason'] as field (field)}
					{#if errors[`adjustment:${field}:${key}`]}<span class={errorText}
							>{errors[`adjustment:${field}:${key}`]}</span
						>{/if}
				{/each}
			</li>
		{/each}
	</ul>
	{#each [...lineFeedback, ...adjustmentFeedback] as text (text)}
		<p class={errorText} role="alert">{text}</p>
	{/each}
	{#if enhanced}
		<button type="button" class={`self-start ${dashedPill}`} {disabled} onclick={addAdjustment}
			>+ Add line</button
		>
	{/if}
</div>
