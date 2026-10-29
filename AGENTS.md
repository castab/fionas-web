# AGENTS.md

Fiona's Ice Cream websites. npm-workspaces monorepo: `apps/public` (marketing site and the /book
request form, which publishes inquiry events to NATS), `apps/admin` (staff console: dashboard, Requests
index, request workspace, quotes, payments, on fionas-commerce), shared packages `@fionas/ui`, `@fionas/design-tokens`,
`@fionas/shared`, and operator scripts in `scripts/`. Stack mirrors `castab/madres-ui`: SvelteKit 2, Svelte 5 runes-only, Vite 8,
Tailwind v4, shadcn-svelte conventions, Vitest + Playwright.

## Where to look

| Need                                       | Read                                                                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brand colors, type, spacing tokens         | `packages/design-tokens/src/tokens.css`                                                                                                            |
| Tailwind utilities for those tokens        | `packages/design-tokens/src/theme.css`                                                                                                             |
| Components (Button, Badge, Card, toast…)   | `packages/ui/src/components/`                                                                                                                      |
| Site details, coming-soon copy             | `packages/shared/src/`                                                                                                                             |
| Inquiry form types, validation, mapping    | `packages/shared/src/inquiry.ts`                                                                                                                   |
| Booking form (`/book`)                     | `apps/public/src/routes/book/`, `$lib/server/menu.ts` (copy + rules)                                                                               |
| Inquiry submission, idempotency, stale     | `docs/public-inquiry-submission.md`, `$lib/server/inquiry-submission.ts`                                                                           |
| Inquiry event contract (AsyncAPI 3.1.0)    | `asyncapi.yaml`, `$lib/server/inquiry-event.ts` (+ `.test.ts` validates against the spec)                                                          |
| Publishing to NATS (outcomes, retry)       | `$lib/server/event-bus.ts`, `$lib/server/nats.ts` (env, connection), `$lib/server/testing/`                                                        |
| Local NATS + JetStream, stream setup       | `compose.yaml`, `infra/nats/nats-server.conf`, `scripts/nats-*.mjs`, `scripts/lib/nats-*.mjs`                                                      |
| Admin architecture, backend access rule    | `docs/admin-architecture.md`                                                                                                                       |
| Admin sign-in, session, guard              | `apps/admin/src/routes/(auth)/login/`, `src/hooks.server.ts`, `$lib/server/auth.ts`                                                                |
| Admin dashboard, shell, data gaps          | `apps/admin/src/routes/(app)/`, `$lib/dashboard.ts`, `docs/admin-dashboard-report.md`                                                              |
| Requests index (filters, search, cursor)   | `docs/admin-requests-index.md`, `$lib/request-list.ts`, `$lib/server/request-list.ts`                                                              |
| Staff request workspace, Quote/deposit     | `docs/admin-request-workspace.md`, `$lib/request-workspace.ts`, `$lib/server/staff-request.ts`                                                     |
| Decline a request (confirm, reason)        | `docs/admin-request-workspace.md`, `$lib/decline.ts`, `decline-controls.svelte`                                                                    |
| Admin quote builder (preview, compose)     | `$lib/quote-builder.ts`, `$lib/components/requests/quote-builder/`, `$lib/server/quote-review.ts`                                                  |
| Quote revision, invoice amendment, history | `$lib/financial-editor.ts`, `$lib/server/editor-actions.ts`, `$lib/service-plan.ts`, `$lib/revision-history.ts`, `docs/admin-request-workspace.md` |
| Categorized service selections             | `$lib/service-selections.ts`, `categorized-selections.svelte`, `service-selections-editor.svelte`                                                  |
| Container images (build from repo root)    | `apps/public/Dockerfile`, `apps/admin/Dockerfile`, `.dockerignore`                                                                                 |
| Gallery                                    | `apps/public/src/routes/gallery/`, `$lib/server/presentation-service/`                                                                             |
| Landing page                               | `apps/public/src/routes/+page.svelte`, `$lib/components/`                                                                                          |

## Commands (run from the repo root)

- Node **v26.9.0** (`.nvmrc`, `engine-strict`).
- `npm run check` must report 0 errors and 0 warnings; `npm run lint` must be clean.
- `npm run test:unit -- --run`; `npm run test:e2e` (builds each app, runs Playwright desktop + mobile;
  the public suite starts NATS with Docker, or uses `E2E_NATS_URL`).
- `npm run nats:up` / `nats:down` / `nats:setup` / `nats:tail` (both prompt for URL + token in a terminal;
  `--non-interactive` skips); `nats:purge` (empties the stream; terminal-only, always asks twice, never add a
  bypass flag); `npm run asyncapi:validate`.

## Rules

- **Svelte 5 runes only**: `$state` / `$derived` / `$props` / `$effect`, snippets not slots,
  `onclick` not `on:click`, `$app/state` not `$app/stores`. Type props explicitly.
- **Style with tokens**, not raw hex: `bg-olive-700`, `text-(--text-muted)`, `[font:var(--type-body)]`.
  The design system's `--text-*` font shorthands are named `--type-*` here (Tailwind owns `--text-*`).
  Don't combine a `[font:…]` shorthand with `text-[size]` on the same element — use discrete utilities.
- Components in `packages/ui` use relative imports (no `$lib`) because apps consume the raw source.
  New classes there are picked up via the `@source` line in each app's `layout.css`.
- Booking is gated with BOOKING_ENABLED=true. /book renders code-owned MENU_SECTIONS projected with private price values; disabled Book CTAs use ComingSoonButton. Success says Request received.
- Only monetary amounts belong in private YAML, supplied by FIONAS_PRICES_FILE (a path) or FIONAS_PRICES_YML (the YAML text itself, which takes precedence). Never commit production prices or load business rules from YAML. Missing/invalid prices or FIONAS_REPLAY_SECRET make booking unavailable; no sample fallback. The immutable process snapshot requires restart, and operators change its revision with every price/menu/rule change. See docs/public-inquiry-submission.md.
- apps/public never calls fionas-commerce. It may call the presentation service server-side only, for gallery reads and view/click tracking; only `$lib/server/presentation-service/transport.server.ts` reads PRESENTATION_SERVICE_* configuration. Never log or expose its URL or token. /book publishes one InquirySubmitted v1 event to NATS JetStream (subject `fionas.inquiries.submitted.v1`, stream `FIONAS_INQUIRIES`). Its NATS user may only publish that subject and subscribe to `_INBOX.>`. Only `$lib/server/nats.ts` reads NATS_* env or connects (lazily, in memory, drained on shutdown); it logs connection changes once each, and /book's load shows the unavailable card unless `isNatsReady()`. Never log/expose NATS URLs, users, passwords, creds paths, price file paths or signing secrets. `nats:setup` refuses to change a differing stream unless `--update` is given.
- **asyncapi.yaml is the contract.** Any payload or header change updates it in the same change and follows its versioning policy: breaking means a new `.vN` subject and message; additive optional fields bump `info.version`'s minor. Keep `inquiry-event.ts`, `isInquirySubmittedEvent` and `scripts/lib/nats-stream.mjs` in step (the tests check them against the spec).
- A browser posts intent only. prepareInquiry validates complete required service; the server prices from its own private snapshot and publishes requestedService, priceRevision and PricedLine records in the event's `data`. Never accept browser amounts, totals, ids or timestamps as authority. All arithmetic is exact, with no truncation or rounding.
- One logical key (sent as `Nats-Msg-Id`; the stream's duplicate window is 24h, the replay window) owns one immutable event, built and signed once. A lost or late PubAck is unknown: retry once with identical bytes, then freeze answers and replay the signed key/digest/time-bound envelope unchanged, even after a price revision changes. A duplicate ack is success for a retry/replay but key_reused for a fresh command's first delivery. No responders, denied publish or a stream refusal is unavailable (never retried). Never forward raw browser replay JSON. Initial stale priceRevision is rejected locally before delivery, requires review and a new key. Pages carrying keys are private/no-store.
- Menu names, selection limits, the guest stepper (50 default, 1–300) and availability are code-owned. There is no service duration anywhere (no question, hourly price, requestedService or servicePlan duration). Keep unavailable chips visible, faded and natively disabled; badge/statusNote popovers and infoNote remain outside input labels. Honor CHIPS and Svelte 5 runes. Never call removed backend catalog/form/estimate APIs.
- **Admin: every call to the commerce backend goes through the SvelteKit server.** The browser only talks
  to the admin origin; backend access lives in `apps/admin/src/lib/server/` (built on `backend.ts`'s
  `request()`) and is called from hooks, `load`, form actions and `+server.ts` only, never from `.svelte`
  or other client code. Session cookies are re-issued on the admin host. See `docs/admin-architecture.md`.
- Light mode only. Motion 120–220ms ease-out, no bounces. Radii: pill / 16 / 10 / 6.
- Admin Issue quote edits the complete ordered final line set: carry/override by lineItemId, remove/reorder, add bespoke signed lines with stable keys. Optional money-free servicePlan holds descriptions and line notes. Staff USER requires financial-document.create, deposit-requirement.manage and fionas.financial-terms.manage. Commerce derives totals/deposit; the browser never sums them. Preview and issuance carry identical lines/plan/terms/version and reviewToken; edits/staleness require explicit approval of a fresh preview. Issue once, PRG to the authoritative GET. Admin never depends on public prices or a catalog. Admin is USD-only (`$lib/currency.ts`): whole-cent flat/tax amounts, ≤12-digit rates that settle to cents, never a browser-chosen currency.
- Admin manual payments require `commerce.payment.record`: Cash/Check/Other only. Quote deposit is
  the full authoritative amount with reviewed version + proposal ID; Invoice partial payments omit
  proposal ID. Never retry a payment mutation; stale/ambiguous outcomes require reload/review. Success
  PRGs to the coherent staff-request GET (including `payments`); only it confirms BOOKED/Invoice.
- Admin Decline requires only `fionas.inquiries.manage` and a coherent REQUESTED inquiry; it posts the
  reviewed Estimate version (never rebased) and a trimmed 1–500 character internal reason, once, then
  PRGs. Uncertain outcomes block every mutation until reload. DECLINED is terminal and never a step
  in the booking progress strip; the validator rejects any incoherent declined projection.
- Admin Requests index (`/requests`): the URL query is the only state (filter, q, opaque cursor);
  one `GET /staff/requests` per load. The backend owns membership, search, order, counts and
  pagination; never filter or classify locally, decode cursors or derive needsClosing. Workspace
  return context is `?from=` holding only a validated list query, rebuilt onto `/requests`; compose
  panel links, actions and PRGs with `workspaceSearch`/`workspaceAction`/`workspaceRedirect`.
- Admin service selections use ordered `{ label, group?, key? }` objects (50 maximum; label 200,
  group/key 120 characters). Group only for presentation by first occurrence; preserve duplicates
  and uncategorized items. Original intent and approved plans are independent. Editor row IDs are
  not source keys; substitutions clear provenance. Native/enhanced edits bind complete selections
  into review fingerprints and require the backend v3 review token. No catalog or pricing inference.
- Admin Revise quote (QUOTED, unsatisfied deposit) and Amend invoice (BOOKED/SERVED) reuse the one editor with
  explicit modes (`INITIAL_QUOTE`, `QUOTE_REVISION`, `INVOICE_AMENDMENT`); the lifecycle picks it and `?quote`,
  `?quote-revision`, `?invoice-revision` open only an eligible one. Revisions seed from the authoritative current
  state and effective service approval (never the original picks), keep negotiated deposit terms, and an Invoice
  amendment never edits the accepted deposit (it needs no deposit authority). The server derives RETAIN / REPLACE /
  CLEAR from the draft against the effective plan; CLEAR needs the deliberate choice, never a blank description.
  Preview and publication use separate revision endpoints with identical bodies plus the preview's `reviewToken`
  (never reused across modes); QUOTE_REVIEW_STALE re-previews for a human; NO_MATERIAL_CHANGE is guidance; an
  uncertain publication blocks until reload. `servicePlan` (bound to the proposal), `effectiveServicePlan` and
  `acceptedServicePlan` differ; retained plans may reference older snapshots and a clearing is valid. Histories
  stay separate; a failed optional history read must not hide the booking.

- Admin Conversation uses `$lib/conversation-contract.ts`, `$lib/server/conversation.ts` and the optional timeline read. See `docs/admin-conversation.md`. Preserve backend order, historical money and attention; never call Resend directly. Replies require communication read/send permissions and an immutable key/body/original expectation. UNKNOWN reconciles only that command. Acknowledge posts the displayed watermark, never a fresh one. Recovery is bounded in memory; a lost pointer blocks resending.
