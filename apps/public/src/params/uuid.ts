import type { ParamMatcher } from '@sveltejs/kit';
import { UUID } from '$lib/payments/contract.js';

/** A nonsecret customer payment publicId. Anything else is a plain 404. */
export const match: ParamMatcher = (param) => UUID.test(param);
