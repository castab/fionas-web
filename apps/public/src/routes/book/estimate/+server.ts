import { json } from '@sveltejs/kit';
import { assertBookingEnabled } from '$lib/server/booking.js';
import { previewEstimate } from '$lib/server/commerce.js';
import type { PricingInputs } from '@fionas/shared';
import type { RequestHandler } from './$types';

/** Proxies the live price estimate to the commerce API (browser → here → backend). */
export const POST: RequestHandler = async ({ request }) => {
	assertBookingEnabled();
	const body = (await request.json().catch(() => null)) as PricingInputs | null;
	if (!body || typeof body !== 'object') {
		return json({ code: 'malformed_request' }, { status: 400 });
	}

	const result = await previewEstimate(body);
	if (result.ok) return json(result.data);
	return json(
		{ code: result.error.code, violations: result.error.violations },
		{
			status: result.error.status
		}
	);
};
