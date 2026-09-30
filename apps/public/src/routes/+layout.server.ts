import { isBookingEnabled } from '$lib/server/booking.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = () => ({
	/** When true the "Book" CTAs link to /book; otherwise they raise the coming-soon toast. */
	bookingEnabled: isBookingEnabled()
});
