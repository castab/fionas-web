import { getGalleryPage } from '$lib/server/presentation-service/gallery.server.js';

// Without this, a build-time misconfiguration (env vars not yet available at build)
// could let this page get prerendered with an empty gallery baked in. Presigned/expiring
// media URLs require this to run fresh per request regardless.
export const prerender = false;

export async function load() {
	const firstPage = await getGalleryPage();
	return { firstPage };
}
