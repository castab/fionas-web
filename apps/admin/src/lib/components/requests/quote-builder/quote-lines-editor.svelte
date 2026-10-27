<script lang="ts">
	import { tick } from 'svelte';
	import { Button, focusRing } from '@fionas/ui';
	import { fieldInput, fieldLabel, groupCaps, hint, lineTool, panelCaps } from './styles.js';
	import type { LineDraft } from '$lib/quote-builder.js';
	import { CURRENCY } from '$lib/currency.js';

	type Kind = 'service' | 'charge' | 'discount' | 'credit' | 'adjustment';
	let {
		lines = $bindable(),
		errors = {},
		guestCount = '',
		hydrated,
		changed,
		editing
	}: {
		lines: LineDraft[];
		/** Seeds the quantity of a new per-guest service. */
		guestCount?: string;
		/** Field errors keyed `line-<position>`, from local or server validation. */
		errors?: Record<string, string>;
		hydrated: boolean;
		/** An edit that should refresh the debounced preview. */
		changed: () => void;
		/** An edit in progress: the review is stale, but no preview runs yet. */
		editing: () => void;
	} = $props();

	const uid = $props.id();
	let root = $state<HTMLElement>();
	/** The one line being edited; every other line shows as a summary. */
	let openId = $state<string | null>(null);
	let choosing = $state(false);
	/** Editor-only labels for lines that start here or are signed. Never submitted. */
	let kinds = $state<Record<string, Kind>>({});
	let pricing = $state<Record<string, 'unit' | 'flat'>>({});
	let more = $state<Record<string, boolean>>({});

	const input = `w-full font-normal ${fieldInput}`;
	const kindNames: Record<Kind, string> = {
		service: 'service',
		charge: 'charge',
		discount: 'discount',
		credit: 'credit',
		adjustment: 'adjustment'
	};
	const modes = [
		{ mode: 'unit', text: 'By quantity' },
		{ mode: 'flat', text: 'Flat amount' }
	] as const;
	const choices: { kind: Exclude<Kind, 'adjustment'>; title: string; hint: string }[] = [
		{ kind: 'service', title: 'Service', hint: 'Something you’ll provide at the event' },
		{ kind: 'charge', title: 'Charge', hint: 'An extra fee, like longer travel' },
		{ kind: 'discount', title: 'Discount', hint: 'Money off the total' },
		{ kind: 'credit', title: 'Credit', hint: 'Something already owed back to them' }
	];
	const blank = (): LineDraft => ({
		key: 'blank-row',
		description: '',
		unitPrice: '',
		taxAmount: '0.00',
		currency: CURRENCY,
		note: ''
	});
	/** Without JavaScript the trailing blank row is how a line is added. */
	const rows = $derived(hydrated ? lines : [...lines, blank()]);
	const idOf = (row: LineDraft) => row.lineItemId ?? row.key ?? '';
	const identity = (row: LineDraft) => (row.lineItemId ? `id:${row.lineItemId}` : `new:${row.key}`);
	const isMoney = (v: string) => /^-?\d+(\.\d+)?$/.test(v.trim());
	/** Summaries always show whole cents; a longer rate keeps its digits. Nothing is rounded. */
	const money = (v: string) => {
		if (!isMoney(v)) return '$—';
		const digits = Math.max(2, (v.trim().split('.')[1] ?? '').replace(/0+$/, '').length);
		return new Intl.NumberFormat('en-US', {
			style: 'currency',
			currency: CURRENCY,
			minimumFractionDigits: digits,
			maximumFractionDigits: digits
		}).format(v.trim() as unknown as number);
	};
	const kindOf = (row: LineDraft): Kind =>
		kinds[idOf(row)] ?? (row.unitPrice.trim().startsWith('-') ? 'adjustment' : 'service');
	/** Discounts and credits are typed as a positive amount off and submitted as a negative price. */
	const signedLayout = (row: LineDraft) =>
		hydrated && ['discount', 'credit', 'adjustment'].includes(kindOf(row)) && !row.quantity?.trim();
	const amountOff = (row: LineDraft) => row.unitPrice.trim().replace(/^-+/, '');
	const perUnit = (row: LineDraft) =>
		(pricing[idOf(row)] ?? (row.quantity?.trim() ? 'unit' : 'flat')) === 'unit';
	const taxed = (row: LineDraft) => isMoney(row.taxAmount) && Number(row.taxAmount) !== 0;
	const moreOpen = (row: LineDraft) => more[idOf(row)] ?? (taxed(row) || !!row.note.trim());
	const priceLabel = (row: LineDraft) =>
		signedLayout(row)
			? `−${money(amountOff(row))}`
			: (hydrated ? perUnit(row) : !!row.quantity?.trim())
				? `${row.quantity?.trim() || '—'} × ${money(row.unitPrice)}`
				: `Flat · ${money(row.unitPrice)}`;
	const title = (row: LineDraft) => row.description.trim() || `New ${kindNames[kindOf(row)]}`;
	const tag = (row: LineDraft) =>
		row.lineItemId ? 'From estimate' : `New ${kindNames[kindOf(row)]}`;

	async function focus(selector: string) {
		await tick();
		root?.querySelector<HTMLElement>(selector)?.focus();
	}
	function open(row: LineDraft) {
		openId = idOf(row);
		choosing = false;
		void focus(`[data-line="${CSS.escape(idOf(row))}"] input:not([type="hidden"])`);
	}
	function close(row: LineDraft) {
		openId = null;
		void focus(`[data-line-summary="${CSS.escape(idOf(row))}"]`);
	}
	function add(kind: Exclude<Kind, 'adjustment'>) {
		const row: LineDraft = { ...blank(), key: crypto.randomUUID() };
		kinds[row.key!] = kind;
		pricing[row.key!] = kind === 'service' ? 'unit' : 'flat';
		if (kind === 'service')
			row.quantity = /^[1-9]\d*$/.test(guestCount.trim()) ? guestCount.trim() : '1';
		lines.push(row);
		openId = row.key!;
		choosing = false;
		// A blank line isn't part of the commitment yet; the preview follows its first edit.
		editing();
		void focus(`[data-line="${CSS.escape(row.key!)}"] input:not([type="hidden"])`);
	}
	function move(i: number, d: number) {
		const row = lines[i];
		if (i + d < 0 || i + d >= lines.length) return;
		[lines[i], lines[i + d]] = [lines[i + d], lines[i]];
		changed();
		const edge = d < 0 ? i + d === 0 : i + d === lines.length - 1;
		void focus(
			`[data-line-action="${edge ? 'remove' : d < 0 ? 'up' : 'down'}:${CSS.escape(idOf(row))}"]`
		);
	}
	function remove(i: number) {
		lines.splice(i, 1);
		openId = null;
		changed();
		void focus('[data-line-add]');
	}
	function setPricing(row: LineDraft, mode: 'unit' | 'flat') {
		pricing[idOf(row)] = mode;
		row.quantity = mode === 'flat' ? undefined : (row.quantity ?? '1');
		changed();
	}
	function setAmountOff(row: LineDraft, value: string) {
		kinds[idOf(row)] = kindOf(row);
		const typed = value.trim().replace(/^-+/, '');
		row.unitPrice = typed ? `-${typed}` : '';
	}
</script>

{#snippet icon(path: string, size = 14)}
	<svg
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="1.75"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"><path d={path}></path></svg
	>
{/snippet}

<div class="flex min-w-0 flex-col gap-3" bind:this={root}>
	<div class="flex flex-wrap items-baseline justify-between gap-2">
		<h3 id={`${uid}-heading`} class={panelCaps}>Quote lines</h3>
		<p class={hint}>
			{lines.length === 1 ? '1 line' : `${lines.length} lines`}{hydrated
				? ' · tap a line to change it'
				: ''}
		</p>
	</div>
	<ul
		aria-labelledby={`${uid}-heading`}
		class="m-0 flex list-none flex-col gap-2 p-0"
		data-testid="quote-lines"
	>
		{#each rows as row, i (row.lineItemId ?? row.key)}
			{@const id = idOf(row)}
			{@const real = i < lines.length}
			{@const isOpen = !hydrated || openId === id}
			{@const error = errors[`line-${i}`]}
			{@const signed = signedLayout(row)}
			{@const per = !hydrated || perUnit(row)}
			<li data-testid="quote-line-editor" data-line={id}>
				<input type="hidden" name="lineIdentity" value={identity(row)} />
				{#if hydrated && !isOpen}
					<button
						type="button"
						class={`flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-input border-[1.5px] bg-cream-200 px-3.5 py-2.5 text-left font-sans text-ink-700 transition-[background-color] duration-(--dur-fast) ease-(--ease-out) hover:bg-cream-300/45 ${error ? 'border-rust-600' : 'border-transparent'} ${focusRing}`}
						aria-expanded="false"
						aria-controls={`${uid}-editor-${id}`}
						aria-label={`Edit line ${i + 1}, ${title(row)}, ${priceLabel(row)}`}
						data-line-summary={id}
						onclick={() => open(row)}
					>
						<span class="flex min-w-0 flex-1 flex-col gap-0.5">
							<span class="flex flex-wrap items-center gap-2">
								<span class="text-sm font-semibold wrap-anywhere">{title(row)}</span>
								<span
									class={[
										'shrink-0 rounded-sm px-2 py-[3px] font-sans text-[9px] leading-[1.4] font-semibold tracking-(--track-caps-tight) uppercase',
										row.lineItemId
											? 'bg-cream-300 text-(--text-muted)'
											: 'bg-olive-700 text-cream-200'
									]}>{tag(row)}</span
								>
							</span>
							{#if row.subDescription?.trim()}<span
									class="text-xs wrap-anywhere text-(--text-muted)">{row.subDescription}</span
								>{/if}
							{#if error}<span class="text-xs text-rust-600">{error}</span>{/if}
						</span>
						<span class="shrink-0 text-[13.5px] font-bold whitespace-nowrap text-(--text-heading)"
							>{priceLabel(row)}</span
						>
						<span class="shrink-0 text-(--text-muted)">{@render icon('m9 18 6-6-6-6', 16)}</span>
					</button>
				{/if}
				<div
					id={`${uid}-editor-${id}`}
					hidden={!isOpen}
					class={[
						'flex flex-col gap-3.5 rounded-input border-[1.5px] p-3.5',
						hydrated
							? 'border-olive-700 bg-(--surface-card) shadow-card'
							: 'border-transparent bg-cream-200'
					]}
				>
					<div class="flex flex-wrap items-center gap-1">
						<span
							class={[
								'shrink-0 rounded-sm px-2 py-[3px] font-sans text-[9px] leading-[1.4] font-semibold tracking-(--track-caps-tight) uppercase',
								real && row.lineItemId
									? 'bg-cream-300 text-(--text-muted)'
									: 'bg-olive-700 text-cream-200'
							]}
							>{real
								? hydrated
									? tag(row)
									: `Line ${i + 1} · ${row.lineItemId ? 'from Estimate' : 'new'}`
								: 'Add a line'}</span
						>
						<span class="flex-1"></span>
						{#if hydrated}
							<button
								type="button"
								class={`${lineTool} font-bold`}
								onclick={() => close(row)}
								data-line-done={id}>Done<span class="sr-only"> editing line {i + 1}</span></button
							>
						{:else if real}
							<button
								type="submit"
								name="rowAction"
								value={`up:${i}`}
								disabled={i === 0}
								class={lineTool}>{@render icon('m18 15-6-6-6 6')}Move up</button
							>
							<button
								type="submit"
								name="rowAction"
								value={`down:${i}`}
								disabled={i === lines.length - 1}
								class={lineTool}>{@render icon('m6 9 6 6 6-6')}Move down</button
							>
							<button
								type="submit"
								name="rowAction"
								value={`remove:${i}`}
								class={`${lineTool} text-rust-600`}
								>{@render icon('M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14')}Remove</button
							>
						{/if}
					</div>
					{#if error}<p role="alert" class="m-0 text-xs text-rust-600">{error}</p>{/if}
					<div class="grid grid-cols-1 gap-2.5 min-[520px]:grid-cols-2">
						<label class={fieldLabel}
							>{!hydrated
								? real
									? 'Description'
									: 'New service or adjustment'
								: kindOf(row) === 'discount'
									? 'Discount name'
									: kindOf(row) === 'credit'
										? 'Credit name'
										: 'What it’s for'}<input
								class={input}
								name="description"
								value={row.description}
								placeholder={hydrated
									? {
											service: 'e.g. Extra toppings bar',
											charge: 'e.g. Extended travel',
											discount: 'e.g. Returning customer discount',
											credit: 'e.g. Credit from rain-out',
											adjustment: ''
										}[kindOf(row)]
									: undefined}
								oninput={(e) => {
									if (real) row.description = e.currentTarget.value;
								}}
								maxlength="200"
							/></label
						>
						<label class={fieldLabel}
							>{#if hydrated}<span
									>Shown under it <span class="font-normal text-(--text-muted)">Optional</span
									></span
								>{:else}Detail{/if}<input
								class={input}
								name="subDescription"
								value={row.subDescription ?? ''}
								oninput={(e) => {
									if (real) row.subDescription = e.currentTarget.value;
								}}
								maxlength="500"
							/></label
						>
					</div>
					{#if signed}
						<div class="flex max-w-55 flex-col gap-1.5">
							<input type="hidden" name="quantity" value="" />
							<input type="hidden" name="unitPrice" value={row.unitPrice} />
							<label class={fieldLabel}
								>{kindOf(row) === 'discount' ? 'Amount off' : 'Credit amount'}
								<span class="relative flex items-center">
									<span
										aria-hidden="true"
										class="pointer-events-none absolute left-3 text-[15px] text-(--text-muted)"
										>−$</span
									><input
										class={`${input} pl-9`}
										value={amountOff(row)}
										inputmode="decimal"
										placeholder="0.00"
										oninput={(e) => setAmountOff(row, e.currentTarget.value)}
									/></span
								></label
							>
							<p class={hint}>Shows on the quote as its own line, taken off the total.</p>
						</div>
					{:else}
						{#if hydrated}
							<div class="flex flex-wrap items-center gap-2.5">
								<span class={`${groupCaps} text-(--text-heading)`} id={`${uid}-priced-${id}`}
									>How it’s priced</span
								>
								<div
									class="inline-flex gap-0.5 rounded-full bg-cream-200 p-[3px]"
									role="group"
									aria-labelledby={`${uid}-priced-${id}`}
								>
									{#each modes as { mode, text } (mode)}
										<button
											type="button"
											aria-pressed={(per ? 'unit' : 'flat') === mode}
											class={`min-h-9.5 cursor-pointer rounded-full border-0 px-4 font-sans text-[11px] leading-[1.4] font-semibold tracking-(--track-caps-tight) uppercase transition-[background-color,color] duration-(--dur-fast) ease-(--ease-out) not-aria-pressed:text-olive-800 aria-pressed:bg-olive-700 aria-pressed:text-cream-200 ${focusRing}`}
											onclick={() => setPricing(row, mode)}>{text}</button
										>
									{/each}
								</div>
							</div>
						{/if}
						<div class="flex flex-wrap items-end gap-2.5">
							{#if per}
								<label class={`${fieldLabel} w-30`}
									>Quantity<input
										class={input}
										name="quantity"
										value={row.quantity ?? ''}
										oninput={(e) => {
											if (real) row.quantity = e.currentTarget.value;
										}}
										inputmode="decimal"
									/></label
								>
								<span aria-hidden="true" class="pb-3 text-[15px] text-(--text-muted)">×</span>
							{:else}
								<input type="hidden" name="quantity" value="" />
							{/if}
							<label class={`${fieldLabel} w-40`}
								>{!hydrated ? 'Unit price' : per ? 'Price each' : 'Amount'}
								<span class="relative flex items-center">
									{#if hydrated}<span
											aria-hidden="true"
											class="pointer-events-none absolute left-3 text-[15px] text-(--text-muted)"
											>$</span
										>{/if}<input
										class={hydrated ? `${input} pl-7` : input}
										name="unitPrice"
										value={row.unitPrice}
										oninput={(e) => {
											if (real) row.unitPrice = e.currentTarget.value;
										}}
										inputmode="decimal"
										placeholder={hydrated ? '0.00' : undefined}
									/></span
								></label
							>
						</div>
					{/if}
					<details
						bind:open={() => !hydrated || moreOpen(row), (v) => (more[id] = v)}
						class="group/more border-t border-(--border-soft) pt-2.5"
					>
						<summary
							class={`flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-sm font-sans text-[11px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-olive-800 uppercase [&::-webkit-details-marker]:hidden ${focusRing}`}
						>
							<span
								class="transition-transform duration-(--dur-fast) ease-(--ease-out) group-open/more:rotate-90"
								>{@render icon('m9 18 6-6-6-6')}</span
							>
							Tax &amp; note
							<span class="font-normal tracking-normal text-(--text-muted) normal-case"
								>{[
									taxed(row) ? `Tax ${money(row.taxAmount)}` : '',
									row.note.trim() ? 'Has a note' : ''
								]
									.filter(Boolean)
									.join(' · ') || 'No tax · no note'}</span
							>
						</summary>
						<div
							class="grid grid-cols-1 gap-2.5 pt-1.5 min-[520px]:grid-cols-[minmax(0,140px)_minmax(0,1fr)]"
						>
							<label class={fieldLabel}
								>Line tax<input
									class={input}
									name="taxAmount"
									value={row.taxAmount}
									oninput={(e) => {
										if (real) row.taxAmount = e.currentTarget.value;
									}}
									inputmode="decimal"
								/></label
							>
							<label class={fieldLabel}
								>{hydrated ? 'Why this line' : 'Reason or service note'}<input
									class={input}
									name="note"
									value={row.note}
									placeholder="Optional — why this line changed"
									oninput={(e) => {
										if (real) row.note = e.currentTarget.value;
									}}
									maxlength="500"
								/></label
							>
						</div>
					</details>
					{#if hydrated}
						<div class="flex flex-wrap items-center gap-1 border-t border-(--border-soft) pt-2">
							<button
								type="button"
								class={lineTool}
								disabled={i === 0}
								data-line-action={`up:${id}`}
								onclick={() => move(i, -1)}>{@render icon('m18 15-6-6-6 6')}Move up</button
							>
							<button
								type="button"
								class={lineTool}
								disabled={i === lines.length - 1}
								data-line-action={`down:${id}`}
								onclick={() => move(i, 1)}>{@render icon('m6 9 6 6 6-6')}Move down</button
							>
							<span class="flex-1"></span>
							<button
								type="button"
								class={`${lineTool} text-rust-600`}
								data-line-action={`remove:${id}`}
								onclick={() => remove(i)}
								>{@render icon('M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14')}Remove line</button
							>
						</div>
					{/if}
				</div>
			</li>
		{/each}
	</ul>
	{#if hydrated && !lines.length}<p
			class="m-0 rounded-input border-[1.5px] border-dashed border-(--border-soft) p-3.5 text-center text-xs text-(--text-muted)"
		>
			No lines yet. Add a service to start the quote.
		</p>{/if}
	{#if hydrated}
		{#if choosing}
			<div
				role="group"
				aria-label="Add a line"
				class="flex flex-col gap-2.5 rounded-input bg-cream-200 p-3.5"
			>
				<p class={panelCaps}>What are you adding?</p>
				<div class="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2">
					{#each choices as choice (choice.kind)}
						<button
							type="button"
							class={`flex min-h-16 cursor-pointer flex-col items-start gap-0.5 rounded-input border-[1.5px] border-(--border-soft) bg-(--surface-card) px-3.5 py-3 text-left font-sans transition-[border-color] duration-(--dur-fast) ease-(--ease-out) hover:border-olive-700 ${focusRing}`}
							onclick={() => add(choice.kind)}
						>
							<span class="text-[13.5px] font-bold text-(--text-heading)">{choice.title}</span>
							<span class="text-xs leading-[1.45] text-(--text-muted)">{choice.hint}</span>
						</button>
					{/each}
				</div>
				<button
					type="button"
					class={`${lineTool} self-start`}
					onclick={() => {
						choosing = false;
						void focus('[data-line-add]');
					}}>Cancel</button
				>
			</div>
		{:else}
			<Button
				type="button"
				variant="secondary"
				class="min-h-11 self-start px-4.5 py-2.5 text-[11px]"
				aria-expanded="false"
				data-line-add
				onclick={() => {
					choosing = true;
					openId = null;
				}}
			>
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg
				>Add line</Button
			>
		{/if}
	{/if}
	<p class={hint}>
		{hydrated
			? 'Nothing is rounded: a rate and quantity must settle to whole cents.'
			: 'Leave quantity blank for a flat amount. Enter a negative unit price for a separate discount or credit. Nothing is rounded.'}
	</p>
</div>
