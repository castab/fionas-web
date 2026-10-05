# Staff request workspace

Dashboard request cards link to authenticated `/requests/{inquiryId}`. Each load sets
`Cache-Control: no-store` and reads exactly one `GET /staff/requests/{inquiryId}` through
`src/lib/server/staff-request.ts` and `backend.ts`. The hook separately resolves the USER session
via `/auth/me`. No browser-to-commerce calls or inquiry/document/catalog enrichment reads occur.

## Presentation boundary

The header and lifecycle strip use `inquiry.lifecycle.stage` exclusively. The workspace presents
name/email, submission date, date-only event date, type, ZIP, guests/minimum flag, duration, and
escaped notes. Original category/offering keys and catalog revision remain secondary in the
collapsed **Original selection details** disclosure. They are identifiers, not historical product
names. Financial lines do not enumerate included/no-charge selections.

Full event address and event-contact details are intentionally collected later when booking.
Their rows say **Collected when booking**: workflow copy, not a missing-data error or placeholder
domain model. ZIP remains the coarse inquiry location. No details are inferred from messages.

The Serving plan renders backend-ordered financial lines, quantities, unit prices, line totals,
subtotal, tax, total, currency, stage/version, and reconciliation balance. Exact decimal strings go
directly to Intl formatting; no repricing or financial arithmetic occurs. Missing reconciliation or
inconsistent document ownership is unavailable rather than an assumed zero balance.

## Issue Quote

The control requires REQUESTED + ESTIMATE and the effective `commerce.financial-document.create`
permission, never a role name. Commerce remains authoritative. The form posts only the reviewed
`expectedVersion` to `?/issueQuote`.

The action validates permission/version, reads this route's projection once, verifies its canonical
relationship and eligibility, and calls `POST /financial-documents/{financial.id}/quote` with the
**submitted version unchanged**. It never accepts a posted document id, substitutes a newer version,
or automatically retries. Backend cookies are re-issued on the admin host.

Success uses **303 to the same clean request pathname**. The subsequent authoritative GET renders
QUOTED / Quote and its new version. The summary says **Quote issued**, and the action disappears.
This supplies confirmation without flash/session infrastructure; refresh cannot repeat issuance.
Native forms and progressive enhancement share this flow. Issuance neither edits nor emails a Quote.

Conflicts, including illegal transitions, require explicit reload/review. Mutation timeout/5xx may
occur after commit, so their copy is ambiguous and further attempts stay blocked until reload.
Enhanced failures retain the reviewed page. Native failed POST rendering may load newer data but
keeps issuance blocked until a clean GET. Backend diagnostic messages never reach UI error copy.

## Shell and limits

Requests is visually current on detail routes while its index remains non-navigable. Dashboard is
no longer current there; Back to dashboard and sign-out remain available. The inbox, staff notes,
Decline, quote editing, communications, and booking/payment workflows are outside this slice.

Historical selection display names are the remaining product-data limitation; a later contract can
provide pinned labels. A later booking/deposit slice can replace intentional booking-detail copy
with authoritative values.

## Coverage

Unit tests cover clients, route scoping, permissions, reviewed-version preservation, redirects,
failures, and presentation. Desktop/mobile E2E has session-isolated projections and mutation counters,
including stale versions and commit followed by 500. Native forms verify PRG and blocked conflicts.

## Implementation and validation

The response fields actually used are:

- Inquiry: `id`, `name`, `email`, `message`, `createdAt`, `zipCode`, `eventDate`, `eventType`,
  `lifecycle.documentId/stage`, and all original `pricingInputs` fields.
- Financial: `id`, `inquiryId`, `version`, `stage`, ordered line `id/description/subDescription/quantity/unitPrice/total/currency`,
  `subtotal`, `taxAmount`, `total`, `currency`, and `reconciliation.balance/currency`.

Changed files (relative to `apps/admin`, except documentation):

- Route/shell: new `src/routes/(app)/requests/[inquiryId]/+page.server.ts`, `+page.svelte`, and
  `page.server.test.ts`; updated `src/routes/(app)/+layout.svelte`.
- Presentation: new `src/lib/request-contract.ts`, `request-workspace.ts`, `request-workspace.test.ts`,
  `presentation.ts`, `components/requests/request-details.svelte`, and `financial-document-card.svelte`;
  updated `src/lib/dashboard.ts`, `dashboard.test.ts`, and `components/dashboard/request-card.svelte`.
- Transport/tests: new `src/lib/server/staff-request.ts`, `staff-request.test.ts`,
  `e2e/request-fixture.mjs`, and `request.e2e.ts`; updated `e2e/stub-commerce.mjs` and `admin.e2e.ts`.
- Documentation: new `docs/admin-request-workspace.md`; updated `docs/admin-architecture.md` and
  `docs/admin-dashboard-report.md`.

Validated on Node v26.9.0:

- `npm run check`: passed; all Svelte checks reported **0 errors and 0 warnings**.
- `npm run lint`: passed Prettier and ESLint.
- `npm run test:unit -- --run`: **398 passed, 2 skipped** across 27 test files. Skips are the existing
  POSIX-specific service-provisioning file-permission tests on Windows.
- `npm run test:e2e`: **140 passed** — 74 admin and 66 public; both app builds completed as part of
  the E2E web-server commands. Final admin presentation/capture edits were verified again with
  `npm run test:e2e --workspace=@fionas/admin`: **74 passed**.
- `git diff --check`: passed. Desktop and mobile workspace screenshots were inspected.

The natural next staff workflow is the deposit/payment-to-book slice, once its authoritative facts
are available; it can reuse this workspace and replace the intentional booking-detail copy.
