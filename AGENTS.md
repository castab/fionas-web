# AGENTS.md

Fiona's Ice Cream websites. npm-workspaces monorepo: `apps/public` (marketing site), `apps/admin`
(staff console: sign-in today), and shared packages `@fionas/ui`, `@fionas/design-tokens`,
`@fionas/shared`. Stack mirrors `castab/madres-ui`: SvelteKit 2, Svelte 5 runes-only, Vite 8,
Tailwind v4, shadcn-svelte conventions, Vitest + Playwright.

## Where to look

| Need                                     | Read                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Brand colors, type, spacing tokens       | `packages/design-tokens/src/tokens.css`                                             |
| Tailwind utilities for those tokens      | `packages/design-tokens/src/theme.css`                                              |
| Components (Button, Badge, Card, toast…) | `packages/ui/src/components/`                                                       |
| Site details, coming-soon copy           | `packages/shared/src/`                                                              |
| Inquiry form types, validation, mapping  | `packages/shared/src/inquiry.ts`                                                    |
| Booking form (`/book`)                   | `apps/public/src/routes/book/`, `$lib/server/commerce.ts`                           |
| Inquiry submission, idempotency, stale   | `docs/public-inquiry-submission.md`, `$lib/server/inquiry-submission.ts`            |
| Public SERVICE auth (token, 401/403)     | `$lib/server/service-auth.ts`, `$lib/server/commerce.ts`, README "Service auth…"    |
| Admin architecture, backend access rule  | `docs/admin-architecture.md`                                                        |
| Admin sign-in, session, guard            | `apps/admin/src/routes/(auth)/login/`, `src/hooks.server.ts`, `$lib/server/auth.ts` |
| Landing page                             | `apps/public/src/routes/+page.svelte`, `$lib/components/`                           |

## Commands (run from the repo root)

- Node **v26.9.0** (`.nvmrc`, `engine-strict`).
- `npm run check` must report 0 errors and 0 warnings; `npm run lint` must be clean.
- `npm run test:unit -- --run`; `npm run test:e2e` (builds each app, runs Playwright desktop + mobile).

## Rules

- **Svelte 5 runes only**: `$state` / `$derived` / `$props` / `$effect`, snippets not slots,
  `onclick` not `on:click`, `$app/state` not `$app/stores`. Type props explicitly.
- **Style with tokens**, not raw hex: `bg-olive-700`, `text-(--text-muted)`, `[font:var(--type-body)]`.
  The design system's `--text-*` font shorthands are named `--type-*` here (Tailwind owns `--text-*`).
  Don't combine a `[font:…]` shorthand with `text-[size]` on the same element — use discrete utilities.
- Components in `packages/ui` use relative imports (no `$lib`) because apps consume the raw source.
  New classes there are picked up via the `@source` line in each app's `layout.css`.
- Booking is gated. `/book` is an inquiry form rendered from the commerce API's `GET /inquiry-form`
  (answers mapped back via each field's `submissionPointer`), with a live `POST /estimate-preview`
  and submit to `POST /inquiries`. It 404s unless `BOOKING_ENABLED=true` (`$lib/server/booking.ts`). While gated the Book CTAs use
  `ComingSoonButton` (`aria-disabled`, raises the toast, never navigates); when enabled they link to `/book`. Playwright needs
  `click({ force: true })` on the gated CTAs.
- The commerce API sends no CORS headers: only server code (`apps/public/src/lib/server/commerce.ts`)
  calls it (`COMMERCE_API_URL`, default `http://localhost:8080`), authenticated as **`SERVICE:fionas-web`**:
  `$lib/server/service-auth.ts` exchanges `COMMERCE_SERVICE_ID` + `COMMERCE_SERVICE_CREDENTIAL` at
  `POST /auth/service/token` for a short-lived access token (in memory only, refreshed early, one exchange at a time),
  sent as `Authorization: Bearer`. A `401` drops that token (only if still current) and repeats the identical request
  once; a `403` is never retried. Both, and any token failure, are `service_auth` errors: logged for the operator,
  "unavailable" (503) to visitors, never a form or selection error. There is no static key. Never log or expose the
  credential or a token (not in page data, cookies, client code or `.env.example`), never decode tokens, and never give
  the app the backend's signing key. The credentials are checked lazily, so the site runs without them while booking is
  off. `apps/admin` uses USER sessions and never this SERVICE. E2E runs against the stub in
  `apps/public/e2e/stub-commerce.mjs` (test-only service credential in `e2e/test-service.ts`).
- **One `Idempotency-Key` per logical submission.** `/book`'s `load` mints the token; the form posts it
  back (hidden `submissionToken`, with `catalogRevision`) and the action sends it unchanged. Never
  generate a key per backend attempt. Retries keep it; only a reviewed catalog refresh
  (`CATALOG_REVISION_STALE`, or a 422 naming unknown/disabled/unavailable offerings) or the customer's
  explicit "Send as a new request" / "Change my answers" changes it. After an unknown outcome the
  answers freeze (`inert`) so the retry is identical. Never auto-resubmit, and never send totals or
  prices: the backend prices and creates the Estimate. See `docs/public-inquiry-submission.md`.
- **No inquiry without configured service (definition version 7).** Every inquiry carries complete
  `pricingInputs` (revision, guest count, duration, required selections); there is no plain/contact-only
  path and no "just send a message" mode. Build the request only with `prepareInquiry`
  (`@fionas/shared`), the submit gate used by both the page and the action. Section `optional` is
  applied as sent; a definition incompatible with `POST /inquiries` (`pricingContractProblem`, e.g. an
  optional section with `/pricingInputs/` questions) is rejected, never coerced: no form is offered and
  nothing is sent. Success copy says "Request received", never booked, confirmed or reserved.
- **Offering availability.** Disabled/retired offerings are absent from `/inquiry-form`; `ENABLED` +
  `UNAVAILABLE` options stay visible but unselectable ("Unavailable — check back later"), never hidden
  or described as removed. Never hardcode offering keys, names, prices or limits in UI code
  (`src/catalog-hardcoding.test.ts`). Browser estimates are advisory (from `pricingPreview`, exact
  decimals); the backend prices.
- **Admin: every call to the commerce backend goes through the SvelteKit server.** The browser only talks
  to the admin origin; backend access lives in `apps/admin/src/lib/server/` (built on `backend.ts`'s
  `request()`) and is called from hooks, `load`, form actions and `+server.ts` only, never from `.svelte`
  or other client code. Session cookies are re-issued on the admin host. See `docs/admin-architecture.md`.
- Light mode only. Motion 120–220ms ease-out, no bounces. Radii: pill / 16 / 10 / 6.
