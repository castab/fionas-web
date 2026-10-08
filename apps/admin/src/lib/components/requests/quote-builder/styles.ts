import { focusRing } from '@fionas/ui';

/** Caps eyebrow used for panel and group headings (11px, letterspaced). */
export const panelCaps =
	'm-0 font-sans text-[11px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-olive-900 uppercase';
/** Smaller caps for category labels inside a group (9.5px). */
export const groupCaps =
	'm-0 font-sans text-[9.5px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-muted) uppercase';
export const hint = 'm-0 text-xs leading-[1.55] text-(--text-muted)';
/** A field surface a step lighter than the panel, matching the design's line inputs. */
export const fieldSurface =
	'rounded-input border border-(--border-soft) bg-[color-mix(in_srgb,var(--cream-100),white_55%)]';
export const fieldInput = `${fieldSurface} box-border min-w-0 px-3 py-2.5 text-sm text-ink-700 transition-[border-color] duration-(--dur-fast) ease-(--ease-out) hover:border-olive-500 aria-invalid:border-rust-600 disabled:opacity-45 ${focusRing}`;
export const dashedPill = `inline-flex min-h-[38px] items-center rounded-full border-[1.5px] border-dashed border-olive-500 bg-transparent px-4 py-2 font-sans text-[11px] font-semibold tracking-(--track-caps-tight) text-olive-800 uppercase transition-[background-color] duration-(--dur-fast) ease-(--ease-out) hover:bg-cream-300/50 disabled:cursor-not-allowed disabled:opacity-45 ${focusRing}`;
export const roundIconButton = `inline-flex shrink-0 items-center justify-center rounded-full border-[1.5px] border-olive-300 bg-transparent text-(--text-muted) transition-[border-color,color] duration-(--dur-fast) ease-(--ease-out) hover:border-rust-600 hover:text-rust-600 disabled:opacity-45 ${focusRing}`;
export const errorText = 'm-0 text-xs text-rust-600';
