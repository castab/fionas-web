import { redirect } from '@sveltejs/kit';
import { assertBookingEnabled } from '$lib/server/booking.js';
import { readReceipt } from '$lib/server/inquiry-submission.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ cookies, setHeaders }) => {
	assertBookingEnabled();
	const stored = readReceipt(cookies);
	if (!stored) redirect(303, '/book');
	setHeaders({ 'cache-control': 'private, no-store' });
	return stored;
};
