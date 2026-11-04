import { createCheckout } from '$lib/server/payments/bff.server.js';
import type { RequestHandler } from './$types';

/** Same-origin hosted Checkout creation or recovery; see bff.server.ts. */
export const POST: RequestHandler = (event) => createCheckout(event);
