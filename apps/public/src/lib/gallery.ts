export type GalleryMediaType = 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM';

/** A media item's own type, independent of its post's `GalleryMediaType` (which for a
 * `CAROUSEL_ALBUM` post says nothing about any individual item). A video whose asset hasn't
 * finished processing can be `"VIDEO"` with `videoUrl` still null. */
export type GalleryItemMediaType = 'IMAGE' | 'VIDEO';

export type GalleryMediaItem = {
	mediaType: GalleryItemMediaType;
	smallUrl: string;
	largeUrl: string;
	/** Pixel dimensions of `largeUrl` — knurl's own decoded size of that variant, not a hint.
	 * Used to size the lightbox to this item's real aspect ratio instead of a fixed box that
	 * would letterbox most non-square content (most of this account's photos are portrait). */
	largeWidth: number;
	largeHeight: number;
	videoUrl: string | null;
	/** Present exactly when `videoUrl` is — the video's own dimensions, which can differ from
	 * `largeWidth`/`largeHeight` (the poster image's size). */
	videoWidth: number | null;
	videoHeight: number | null;
};

/** One post. `mediaItems` holds every item in knurl's own order (a `CAROUSEL_ALBUM` post
 * has more than one; a single photo/video always has exactly one). */
export type GalleryTile = {
	id: string;
	mediaType: GalleryMediaType;
	caption: string | null;
	permalink: string;
	mediaItems: GalleryMediaItem[];
};

export type GalleryTrackingEvent = 'view' | 'click';

/** One page of gallery posts, per knurl's `{ data, pagination }` envelope. `hasNextPage` is
 * derived from `currentPage`/`totalPages` rather than exposing knurl's full pagination shape
 * (total record counts, link URLs) that this app has no use for. */
export type GalleryPage = {
	tiles: GalleryTile[];
	currentPage: number;
	hasNextPage: boolean;
};
