import { comingSoonToast, instagramUrl } from '@fionas/shared';
import type { ComingSoonToastOptions } from '@fionas/ui';

/** Toast raised by every "Book" CTA until online booking ships. */
export const bookingComingSoon: ComingSoonToastOptions = {
	...comingSoonToast,
	actionHref: instagramUrl
};
