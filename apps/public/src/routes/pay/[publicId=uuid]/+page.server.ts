import type { PageServerLoad } from './$types';

/**
 * Deliberately empty. The bearer lives in the URL fragment, which never reaches the server, and
 * nothing about the booking is rendered server-side: the browser reads it through the BFF.
 * hooks.server.ts adds no-store, no-referrer and noindex headers to this route.
 */
export const load: PageServerLoad = () => ({});
