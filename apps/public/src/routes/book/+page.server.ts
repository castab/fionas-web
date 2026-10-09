import { fail, redirect } from '@sveltejs/kit';
import { getPriceBook, projectForm } from '$lib/server/price-book.js';
import { replaySecret } from '$lib/server/inquiry-replay.js';
import { assertBookingEnabled } from '$lib/server/booking.js';
import { isNatsReady } from '$lib/server/nats.js';

import { newSubmissionToken, storeReceipt, submitInquiry } from '$lib/server/inquiry-submission.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ setHeaders }) => {
	assertBookingEnabled();
	// The page carries a per-visitor submission token: no shared cache may ever reuse it.
	setHeaders({ 'cache-control': 'private, no-store' });
	let form = null;
	try {
		replaySecret();
		form = projectForm(getPriceBook());
	} catch {
		console.error('[booking] Private pricing or replay configuration unavailable');
	}
	// Don't let a customer fill in a form that can't be sent. nats.ts logs why, once per outage.
	if (form && !(await isNatsReady())) form = null;
	return { form, submissionToken: newSubmissionToken() };
};

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		assertBookingEnabled();
		const result = await submitInquiry(await request.formData());
		if (!result.ok) return fail(result.status, result.failure);

		storeReceipt(cookies, url, result.receipt, result.firstName);
		redirect(303, '/book/received');
	}
};
