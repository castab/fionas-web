<script lang="ts" module>
	import { type VariantProps, tv } from 'tailwind-variants';

	export const cardVariants = tv({
		base: 'rounded-card p-6',
		variants: {
			variant: {
				raised: 'bg-(--surface-card) shadow-card',
				flat: 'border border-(--border-soft) bg-(--surface-card)',
				inverse: 'bg-(--surface-inverse) text-(--text-on-inverse)'
			}
		},
		defaultVariants: {
			variant: 'raised'
		}
	});

	export type CardVariant = VariantProps<typeof cardVariants>['variant'];
</script>

<script lang="ts">
	import { cn, type WithElementRef } from '../../utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		variant = 'raised',
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		variant?: CardVariant;
	} = $props();
</script>

<div
	bind:this={ref}
	data-slot="card"
	class={cn(cardVariants({ variant }), className)}
	{...restProps}
>
	{@render children?.()}
</div>
