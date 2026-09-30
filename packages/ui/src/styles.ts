/** Design-system focus treatment: 3px --focus-ring outline, offset 2px. */
export const focusRing =
	'focus-visible:outline-solid focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)';

/** Letterspaced small caps used for labels, nav and prices. */
export const capsSm = '[font:var(--type-caps-sm)] tracking-(--track-caps-tight) uppercase';

/** The same caps treatment one step smaller (11px), for compact form labels and eyebrows. */
export const capsXs =
	'font-sans text-[11px] leading-[1.4] font-semibold tracking-(--track-caps-tight) uppercase';

/** Small supporting text under a control (12px). */
export const hintText = 'font-sans text-xs leading-[1.45] text-(--text-muted)';

/** Shared look of text-like form controls (input, textarea, select): compact 46px fields. */
export const controlBase = [
	'w-full rounded-input border border-olive-300/70 bg-cream-100 px-3.5 py-2.5 font-sans text-base leading-6 text-(--text-body)',
	'transition-[border-color,box-shadow] duration-(--dur-fast) ease-(--ease-out)',
	'placeholder:text-(--text-muted)/60 hover:border-olive-500 focus-visible:border-olive-700',
	'aria-invalid:border-rust-600 disabled:cursor-not-allowed disabled:opacity-45'
].join(' ');
