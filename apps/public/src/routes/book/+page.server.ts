import { fail } from '@sveltejs/kit';
import {
	answersFromFormData,
	buildInquiryRequest,
	describeViolation,
	validateAnswers,
	type ApiError
} from '@fionas/shared';
import { assertBookingEnabled } from '$lib/server/booking.js';
import { createInquiry, getInquiryForm } from '$lib/server/commerce.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	assertBookingEnabled();
	const result = await getInquiryForm();
	return { form: result.ok ? result.data : null };
};

/** Visitor-facing copy for a failed POST /inquiries. Never echoes the server's diagnostic text. */
function submitFailureMessage(error: ApiError): string {
	if (error.status === 422 && error.violations.length > 0) {
		return [...new Set(error.violations.map(describeViolation))].join(' ');
	}
	if (error.status === 422 || error.status === 400) {
		return describeViolation('');
	}
	if (error.status === 404) {
		return 'Our menu just changed. Please reload the page and choose again.';
	}
	return "We couldn't send your inquiry just now. Please try again in a moment.";
}

export const actions: Actions = {
	default: async ({ request }) => {
		assertBookingEnabled();
		const data = await request.formData();

		const formResult = await getInquiryForm();
		if (!formResult.ok) {
			return fail(503, {
				formError: "We couldn't send your inquiry just now. Please try again in a moment."
			});
		}
		const form = formResult.data;

		const answers = answersFromFormData(form, data);
		const errors = validateAnswers(form, answers);
		if (Object.keys(errors).length > 0) {
			return fail(422, { answers, errors });
		}

		const inquiry = buildInquiryRequest(form, answers);
		let result = await createInquiry(inquiry);
		// A concurrent request created the same customer first; the API says a retry succeeds.
		if (!result.ok && result.error.code === 'conflict') {
			result = await createInquiry(inquiry);
		}
		if (!result.ok) {
			return fail(result.error.status >= 500 ? 503 : 422, {
				answers,
				formError: submitFailureMessage(result.error)
			});
		}

		return { success: true as const };
	}
};
