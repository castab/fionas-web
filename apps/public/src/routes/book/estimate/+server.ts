import { json } from '@sveltejs/kit';
import type { PricingInputs } from '@fionas/shared';
import { assertBookingEnabled } from '$lib/server/booking.js';
import { previewEstimate } from '$lib/server/commerce.js';
import type { RequestHandler } from './$types';

const isInt = (v: unknown, min: number): v is number =>
	typeof v === 'number' && Number.isInteger(v) && v >= min && v <= 2_147_483_647;

/** Only the documented pricing facts go upstream, rebuilt field by field: never amounts. */
function pricingInputsOf(body: unknown): PricingInputs | null {
	if (typeof body !== 'object' || body === null) return null;
	const b = body as Record<string, unknown>;
	if (!isInt(b.catalogRevision, 1) || !isInt(b.guestCount, 1) || !isInt(b.durationMinutes, 1)) {
		return null;
	}
	const minimum = b.guestCountIsMinimum;
	if (minimum !== undefined && typeof minimum !== 'boolean') return null;
	if (!Array.isArray(b.selections)) return null;
	const selections: PricingInputs['selections'] = [];
	for (const s of b.selections as unknown[]) {
		const block = s as { category?: unknown; offerings?: unknown };
		if (typeof block?.category !== 'string' || !Array.isArray(block.offerings)) return null;
		if (!block.offerings.every((o): o is string => typeof o === 'string')) return null;
		selections.push({ category: block.category, offerings: [...block.offerings] });
	}
	return {
		catalogRevision: b.catalogRevision,
		guestCount: b.guestCount,
		guestCountIsMinimum: b.guestCountIsMinimum === true,
		durationMinutes: b.durationMinutes,
		selections
	};
}

/**
 * Proxies the authoritative (non-writing) estimate preview to the commerce API: browser → here →
 * backend, authenticated as the site's SERVICE. Answers with the backend's stable codes only, never
 * its diagnostic message.
 */
export const POST: RequestHandler = async ({ request }) => {
	assertBookingEnabled();
	const inputs = pricingInputsOf(await request.json().catch(() => null));
	if (!inputs) return json({ code: 'malformed_request' }, { status: 400 });

	const result = await previewEstimate(inputs);
	if (result.ok) return json(result.data);
	const { status, code, violations, kind } = result.error;
	// Our own failures upstream (service auth, contract) are an outage to the browser, never a
	// refusal of the customer's choices: the page keeps its advisory figures.
	if (kind === 'service_auth' || kind === 'unexpected') {
		return json({ code: 'unavailable' }, { status: 503 });
	}
	return json({ code, violations }, { status });
};
