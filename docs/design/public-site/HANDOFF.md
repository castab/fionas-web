# Public site design handoff (home, book, received, gallery)

The `.dc.html` files next to this note are the approved design for the public site, exported from
the Claude Design canvas "Fiona's Ice Cream — Public Site". They are **reference only**: they load
a design-system bundle (`ds/…/bundle.js`) and a canvas runtime (`support.js`) that are not in this
repo, so they will not render here. Read them as markup + inline styles; every color in them is a
token from `packages/design-tokens/src/tokens.css` written out as hex (map back to tokens, see the
table at the end). Nothing in this folder ships.

| File               | Route            | Status vs. `main`                                                          |
| ------------------ | ---------------- | -------------------------------------------------------------------------- |
| `Main.dc.html`     | `/`              | Copy changes + new header nav. Layout otherwise matches today's page.      |
| `Book.dc.html`     | `/book`          | Header nav only. Form, estimate and states are a port of today's page.     |
| `Received.dc.html` | `/book/received` | Header nav only.                                                           |
| `Gallery.dc.html`  | `/gallery`       | **New page**, modelled on `castab/madres-ui` `apps/madres-web` `/gallery`. |

## 1. Site header (all pages) — `apps/public/src/lib/components/site-header.svelte`

- Wrap the right side in `<nav aria-label="Main">` with `gap: 8px`, items centred.
- New **Gallery** link before the Book CTA: a text link styled as a quiet pill —
  `min-h-11 px-3.5 rounded-full`, caps-sm (`12px/600`, `tracking-(--track-caps-tight)`, uppercase),
  `text-olive-800`; hover `bg-cream-300 text-olive-900`; standard focus ring. On `/gallery` it gets
  `aria-current="page"` and keeps the `bg-cream-300` fill.
- Book CTA unchanged (primary `sm` button / `ComingSoonButton` when booking is gated).
- Wordmark: the canvas shows it at 42px tall (it was enlarged during review). Today's
  `Wordmark` default is `h-11` (44px), which already satisfies that — keep `h-11`, don't shrink it.
- Must still fit at 360px wide: wordmark + Gallery + Book on one row. If it doesn't, reduce the
  header's horizontal padding at `max-[480px]` before touching the wordmark.

## 2. Landing page — `apps/public/src/routes/+page.svelte`

- Secondary CTA label: **"Book your scoops"** (was "Book the trailer"), in both branches
  (`Button href="/book"` and `ComingSoonButton`). Update e2e selectors that match the old text
  (`apps/public/e2e/landing.e2e.ts`, `e2e/booking/cta.e2e.ts`).
- Intro paragraph becomes exactly:
  "Soft serve & hand-scooped classics brought right to your driveway, park, or backyard across
  Fresno & the Madera Ranchos."
  (The "Our little website is churning — follow along while we set up." sentence is removed.)
- Same wording change in the `<meta name="description">` in `routes/+layout.svelte`.
- Narrow viewports: copy is centred with the badge stacked on top below 940px. The current
  Tailwind classes already do this — keep them.
- Everything else (badge "Booking late 2026" when gated, h1, Instagram CTA, LogoBadge) unchanged.

## 3. `/book` and `/book/received`

No changes beyond the header. The design files are a faithful port; where they differ from the code
(e.g. estimate prices shown as `[BASE PRICE]` placeholders, simplified chip popovers) the **code
wins** — those were canvas limitations, not design decisions.

## 4. New `/gallery` page — `Gallery.dc.html`

Port the structure and behaviour of `castab/madres-ui` → `apps/madres-web/src/routes/gallery/`
(`+page.server.ts`, `+page.svelte`, `gallery-client.svelte`, `gallery-helpers.ts`,
`lightbox-carousel.svelte`, `load-more/+server.ts`, `track/+server.ts`) and
`src/lib/server/presentation-service/` (`transport.server.ts`, `gallery.server.ts` + tests). It is
driven by the same presentation service, configured per app via `PRESENTATION_SERVICE_BASE_URL`,
`PRESENTATION_SERVICE_ACCOUNT_ID`, `PRESENTATION_SERVICE_GALLERY_NAME`,
`PRESENTATION_SERVICE_TRACKING_TOKEN` (server-only, `$env/dynamic/private`; add them to
`apps/public/.env.example` without values).

### Layout (top to bottom)

1. **Intro**, centred, `max-w-[720px]`, padding `56px 20px 40px`, gap 16px:
   - eyebrow "From the feed" — caps-sm, `tracking-(--track-caps)` (0.26em), `text-olive-600`
   - h1 "a few favorites from recent events" — 40px/1.15, 700, `tracking-(--track-heading)`,
     `text-(--text-heading)`, `text-balance` (lowercase is intentional, matches "bring fionas…")
   - lead "A scoop of the good stuff from @fionasicecream — tap any photo or video to see it
     larger." — 17px/1.65, `text-(--text-muted)`, `max-w-[520px]`
   - secondary outline pill link "Follow @fionasicecream" with the Instagram icon → `instagramUrl`
     (`target="_blank" rel="noopener noreferrer"`), `min-h-12`.
2. **Grid** `section[aria-label="Photos and videos"]`, `max-w-(--container-max)` (1080), padding
   `0 20px 48px`, `gap-3`, columns
   `repeat(auto-fill, minmax(min(176px, calc(50% - 6px)), 1fr))` → 2 columns on phones, up to 5.
   Each tile is a `<button>`:
   - card: `rounded-card` (16), hairline `border-(--border-soft)`, `bg-(--surface-card)`,
     `shadow-raised`; hover lifts 2px to `shadow-card` (220ms ease-out); focus ring.
   - square media box (`aspect-square`, `object-cover` thumbnail `smallUrl`) on a `bg-paper-200`
     placeholder; while loading show a spinner (olive ring) like madres.
   - VIDEO: centred 48px round play badge, `bg-ink-900/55`, cream icon.
     CAROUSEL_ALBUM: 30px round layers badge top-right, same colours.
   - caption under the media: 14px/1.6 `text-(--text-muted)`, padding `12px 16px`, truncated at
     10 words (`truncateCaption`); fallback "A moment from @fionasicecream".
   - `aria-label`: "View {photo|video|album} {n} of {total}: {caption}".
3. **Footer of grid**: secondary `Button` "Load more" (→ `/gallery/load-more?page=n`, "Loading…"
   while busy, rust error line "Couldn't load more photos. Please try again."); when no next page,
   `role="status"` "You're all caught up." 14px muted.
4. **Empty state** (no tiles): centred muted paragraph "New photos and videos are on their way.
   Follow along on Instagram to see them first." (not drawn on the canvas; use this copy).

### Lightbox (click a tile)

- `role="dialog" aria-modal="true"`, fixed overlay `bg-ink-900/65`, padding 20px; click outside or
  Esc closes; focus moves in and is restored on close (as madres does).
- Panel `w-[min(480px,100%)] max-h-[90dvh]`, `rounded-card`, `bg-(--surface-card)`, `shadow-card`,
  scrolls if tall.
- Media area takes the item's real aspect ratio (`aspectRatioFor`), `object-contain`, on
  `bg-paper-200`. 44px round controls `bg-ink-900/55` cream icons: Close (top-right), Previous /
  Next (vertically centred left/right). Prev/next step through an album's slides first, then move
  to the neighbouring tile. Swipe on touch (madres' `SWIPE_THRESHOLD_PX`).
- Video: bottom pill bar `bg-ink-900/55` with play/pause, seek range (accent `olive-700`),
  `m:ss/m:ss`, mute toggle; muted by default.
- Albums: dot row under the media, 7px dots, current `bg-olive-700`, others `bg-olive-900/25`,
  each a 24px hit target with `aria-current`.
- Body (padding 20, gap 12): `Badge` "Video" (olive) for videos; full caption 15px/1.65
  `text-(--text-body)`; "View on Instagram" link (14px/600, `text-olive-800`, underline on hover) to
  the post `permalink`, which also fires the `click` tracking event. Record `view` when a tile opens.

### Footer

Today's footer links Instagram externally; keep that on every page (no madres-style in-app
"Instagram → /gallery" swap).

## Token map for the hex values in the `.dc.html` files

| Hex                                | Token                                                   |
| ---------------------------------- | ------------------------------------------------------- |
| `#3d3a2b`                          | `olive-900` / `--text-heading`                          |
| `#4a4733`                          | `olive-800` / `--brand-strong`                          |
| `#5f5b40`                          | `olive-700` / `--brand`                                 |
| `#6f6a4e`                          | `olive-600`                                             |
| `#aaa68e` (`rgba(170,166,142,.7)`) | `olive-300` (at 70%)                                    |
| `#f6f1e4`                          | `cream-100` / `--surface-card`                          |
| `#ede5d3`                          | `cream-200` / `--surface-page`                          |
| `#e2d8c3`                          | `cream-300`                                             |
| `#d5cec6` `#ddd6cc` `#d9d6c6`      | `paper-200` `paper-100` `olive-100` (placeholders only) |
| `#2b2921`                          | `ink-700` / `--text-body`                               |
| `#55523f`                          | `ink-500` / `--text-muted`                              |
| `rgba(18,16,12,…)`                 | `ink-900` with opacity                                  |
| `#a3492f`                          | `rust-600`                                              |
| `#6b7a4a`                          | `moss-600`                                              |
| `rgba(61,58,43,.16)`               | `--border-soft`                                         |
| `rgba(95,91,64,.45)`               | `--focus-ring`                                          |
