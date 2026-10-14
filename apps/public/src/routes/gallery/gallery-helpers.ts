import type { GalleryMediaItem, GalleryMediaType, GalleryTile } from '$lib/gallery.js';

export function tileAlt(tile: GalleryTile, instagramHandle: string): string {
	return tile.caption ?? `Photo from @${instagramHandle}`;
}

export function mediaTypeWord(mediaType: GalleryMediaType): string {
	if (mediaType === 'VIDEO') return 'video';
	if (mediaType === 'CAROUSEL_ALBUM') return 'album';
	return 'photo';
}

/** Whether a slide has a ready-to-play video asset right now. A "VIDEO" item can still have
 * a null videoUrl while knurl's ingestion hasn't finished processing it yet. */
export function isPlayableItem(item: GalleryMediaItem): boolean {
	return item.videoUrl !== null;
}

/** The aspect ratio of whatever a slide is actually showing right now — the video's own
 * dimensions once it's playable, else the poster/photo's. Most of this account's content is
 * portrait, so sizing the lightbox box to a fixed square (or any one fixed ratio) would
 * letterbox nearly everything; matching the current item's real ratio instead means no bars
 * for it, whatever shape it is. */
export function aspectRatioFor(item: GalleryMediaItem): number {
	const width = isPlayableItem(item) ? (item.videoWidth ?? item.largeWidth) : item.largeWidth;
	const height = isPlayableItem(item) ? (item.videoHeight ?? item.largeHeight) : item.largeHeight;
	return width > 0 && height > 0 ? width / height : 1;
}

/** Minimum horizontal drag, in pixels, for a touch gesture at a carousel's scroll boundary
 * to count as a swipe to the next/previous post rather than an incidental touch. */
export const SWIPE_THRESHOLD_PX = 48;

/**
 * Whether a keyboard event's target is one of the lightbox's own interactive controls
 * (Close/Prev/Next/mute/play-pause buttons, the seek bar, the carousel dots, the Instagram
 * link). Each of those already has its own Space/Enter behavior, so the Space-to-toggle-
 * playback shortcut must not also fire while one of them is focused.
 */
export function isInteractiveDialogElement(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (!target.closest('[role="dialog"]')) return false;
	return target.closest('button, a, input, select, textarea') !== null;
}

/** `M:SS`, e.g. `10` -> `"0:10"`, `90` -> `"1:30"`. */
export function formatDuration(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

export const GRID_CAPTION_WORD_LIMIT = 10;

/** Grid cards stay picture-first: cut long captions at a word boundary rather than
 * however many characters happen to fit a line box. The full caption still appears
 * in the lightbox and in this tile's aria-label/alt text. */
export function truncateCaption(caption: string): string {
	const words = caption.trim().split(/\s+/);
	if (words.length <= GRID_CAPTION_WORD_LIMIT) return caption;
	return `${words.slice(0, GRID_CAPTION_WORD_LIMIT).join(' ')}…`;
}
