import { backendConfig } from '$lib/server/config.js';
import { subscribeTimeline } from '$lib/server/timeline-updates.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, request, url }) =>
	subscribeTimeline(
		backendConfig(url.origin),
		params.inquiryId,
		request.headers.get('cookie'),
		request.signal
	);
