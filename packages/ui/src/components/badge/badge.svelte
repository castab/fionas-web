<script lang="ts" module>
	import { type VariantProps, tv } from 'tailwind-variants';
	import { capsSm } from '../../styles.js';

	export const badgeVariants = tv({
		base: ['inline-flex items-center gap-1.5 rounded-full px-3 py-1', capsSm],
		variants: {
			tone: {
				olive: 'bg-olive-100 text-olive-900',
				inverse: 'bg-olive-700 text-cream-200',
				moss: 'bg-moss-600 text-cream-100',
				rust: 'bg-rust-600 text-cream-100'
			}
		},
		defaultVariants: {
			tone: 'olive'
		}
	});

	export type BadgeTone = VariantProps<typeof badgeVariants>['tone'];
</script>

<script lang="ts">
	import { cn, type WithElementRef } from '../../utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		tone = 'olive',
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLSpanElement>> & {
		tone?: BadgeTone;
	} = $props();
</script>

<span
	bind:this={ref}
	data-slot="badge"
	class={cn(badgeVariants({ tone }), className)}
	{...restProps}
>
	{@render children?.()}
</span>
