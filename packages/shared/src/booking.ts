/*
 * Online booking isn't built yet. Every "Book" CTA renders as an aria-disabled button that only
 * raises this coming-soon toast; nothing navigates or submits.
 */

/** Shown in the hero badge while booking is gated. */
export const bookingLaunchLabel = 'Booking late 2026';

export const comingSoonToast = {
	title: 'Booking opens soon',
	description:
		"We're still setting up the calendar. Follow along and we'll post the moment we're bookable. 🍦",
	actionLabel: 'Follow on Instagram',
	timeoutMs: 9000
} as const;
