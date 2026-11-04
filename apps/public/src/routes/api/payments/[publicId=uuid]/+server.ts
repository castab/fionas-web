import { paymentSummary } from '$lib/server/payments/bff.server.js';
import type { RequestHandler } from './$types';

/** Same-origin read of the customer-safe payment summary; see bff.server.ts. */
export const GET: RequestHandler = (event) => paymentSummary(event);
