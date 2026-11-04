import type { Handle } from '@sveltejs/kit';
import { PAYMENT_HEADERS, isPaymentPath } from '$lib/server/payments/bff.server.js';

export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	if (!isPaymentPath(event.url.pathname)) return response;
	const headers = {
		...PAYMENT_HEADERS,
		// Nothing may frame the payment page (no clickjacking of the Pay button).
		'content-security-policy': "frame-ancestors 'none'",
		'x-content-type-options': 'nosniff'
	};
	try {
		for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
		return response;
	} catch {
		// Immutable headers: copy the response rather than serve it without the policy.
		const copy = new Response(response.body, response);
		for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value);
		return copy;
	}
};
