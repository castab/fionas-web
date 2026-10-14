import { getGalleryPage } from '$lib/server/presentation-service/gallery.server.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async ({ url }) => {
	const page = Number(url.searchParams.get('page') ?? '1');
	return Response.json(await getGalleryPage(Number.isSafeInteger(page) && page > 0 ? page : 1));
};
