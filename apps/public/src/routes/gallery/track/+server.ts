import { trackGalleryEvent } from '$lib/server/presentation-service/gallery.server.js';
import type { RequestHandler } from './$types.js';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const id = typeof body?.id === 'string' ? body.id : null;
	const event = body?.event === 'view' || body?.event === 'click' ? body.event : null;
	if (!id || !event) return Response.json({ ok: false }, { status: 400 });

	await trackGalleryEvent(id, event);
	return Response.json({ ok: true });
};
