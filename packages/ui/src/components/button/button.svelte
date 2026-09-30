<script lang="ts" module>
	import { type VariantProps, tv } from 'tailwind-variants';
	import { cn, type WithElementRef } from '../../utils.js';
	import { focusRing } from '../../styles.js';
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';

	/** Mirrors the design system's `.fds-btn` recipe: pill, letterspaced caps, 2px border. */
	export const buttonVariants = tv({
		base: [
			'inline-flex cursor-pointer items-center justify-center gap-2 rounded-full border-2 border-transparent',
			'font-sans font-semibold tracking-(--track-caps-tight) whitespace-nowrap uppercase no-underline',
			'transition-[background-color,color,box-shadow,transform] duration-(--dur-fast) ease-(--ease-out)',
			'active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45 disabled:active:translate-y-0',
			focusRing
		],
		variants: {
			variant: {
				primary: 'bg-olive-700 text-cream-200 not-disabled:hover:bg-olive-800',
				secondary: 'border-olive-700 bg-transparent text-olive-800 not-disabled:hover:bg-olive-100',
				ghost: 'bg-transparent text-olive-800 not-disabled:hover:bg-olive-100'
			},
			size: {
				sm: 'px-[18px] py-2 text-[11px]',
				md: 'px-[26px] py-3 text-xs',
				lg: 'px-9 py-4 text-sm'
			}
		},
		defaultVariants: {
			variant: 'primary',
			size: 'md'
		}
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>['variant'];
	export type ButtonSize = VariantProps<typeof buttonVariants>['size'];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
		};
</script>

<script lang="ts">
	let {
		class: className,
		variant = 'primary',
		size = 'md',
		ref = $bindable(null),
		href = undefined,
		type = 'button',
		disabled,
		children,
		...restProps
	}: ButtonProps = $props();
</script>

{#if href}
	<!-- eslint-disable svelte/no-navigation-without-resolve -- generic primitive; callers resolve() their own href -->
	<a
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		href={disabled ? undefined : href}
		aria-disabled={disabled}
		role={disabled ? 'link' : undefined}
		tabindex={disabled ? -1 : undefined}
		{...restProps}
	>
		{@render children?.()}
	</a>
	<!-- eslint-enable svelte/no-navigation-without-resolve -->
{:else}
	<button
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		{type}
		{disabled}
		{...restProps}
	>
		{@render children?.()}
	</button>
{/if}
