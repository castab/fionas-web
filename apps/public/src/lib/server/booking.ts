import { env } from '$env/dynamic/private';
import { error } from '@sveltejs/kit';

/** Booking is live only when BOOKING_ENABLED=true (read per request, so a restart picks up edits). */
export const isBookingEnabled = () => env.BOOKING_ENABLED === 'true';

/** Makes every /book entry point (page, form action, estimate endpoint) 404 while booking is off. */
export function assertBookingEnabled(): void {
	if (!isBookingEnabled()) error(404, 'Not found');
}
