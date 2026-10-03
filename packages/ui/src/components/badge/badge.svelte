<script lang="ts" module>
	import { type VariantProps, tv } from 'tailwind-variants';
	import { capsSm } from '../../styles.js';

	export const badgeVariants = tv({
		base: 'inline-flex items-center gap-1.5 rounded-full',
		variants: {
			tone: {
				olive: 'bg-olive-100 text-olive-900',
				inverse: 'bg-olive-700 text-cream-200',
				moss: 'bg-moss-600 text-cream-100',
				rust: 'bg-rust-600 text-cream-100',
				outline: 'border border-olive-300 bg-transparent text-olive-700'
			},
			size: {
				md: ['px-3 py-1', capsSm],
				// Discrete utilities, not the `[font:…]` shorthand: it can't pair with a custom size.
				sm: 'px-2.5 py-0.5 font-sans text-[10px] leading-[1.4] font-semibold tracking-(--track-caps-tight) uppercase'
			}
		},
		defaultVariants: {
			tone: 'olive',
			size: 'md'
		}
	});

	export type BadgeTone = VariantProps<typeof badgeVariants>['tone'];
	export type BadgeSize = VariantProps<typeof badgeVariants>['size'];
</script>

<script lang="ts">
	import { cn, type WithElementRef } from '../../utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		tone = 'olive',
		size = 'md',
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLSpanElement>> & {
		tone?: BadgeTone;
		size?: BadgeSize;
	} = $props();
</script>

<span
	bind:this={ref}
	data-slot="badge"
	class={cn(badgeVariants({ tone, size }), className)}
	{...restProps}
>
	{@render children?.()}
</span>
