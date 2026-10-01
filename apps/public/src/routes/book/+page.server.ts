import { fail, redirect } from '@sveltejs/kit';
import { pricingContractProblem } from '@fionas/shared';
import { assertBookingEnabled } from '$lib/server/booking.js';
import { getInquiryForm } from '$lib/server/commerce.js';
import { newSubmissionToken, storeReceipt, submitInquiry } from '$lib/server/inquiry-submission.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ setHeaders }) => {
	assertBookingEnabled();
	// The page carries a per-visitor submission token: no shared cache may ever reuse it.
	setHeaders({ 'cache-control': 'private, no-store' });
	const result = await getInquiryForm();
	// A form that can't produce pricingInputs can't produce an inquiry: show "unavailable" instead
	// of questions nobody could successfully submit (the adapter has logged why).
	const usable = result.ok && pricingContractProblem(result.data) === null;
	return {
		form: usable ? result.data : null,
		/** Names this rendering's one logical submission; posted back and sent as `Idempotency-Key`. */
		submissionToken: newSubmissionToken()
	};
};

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		assertBookingEnabled();
		const result = await submitInquiry(await request.formData());
		if (!result.ok) return fail(result.status, result.failure);

		storeReceipt(cookies, url, result.receipt);
		redirect(303, '/book/received');
	}
};
