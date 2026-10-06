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

Issue Quote is one atomic approval: Quote + explicit deposit requirement + durable proposal issuance.
The control requires REQUESTED + ESTIMATE, no proposal, a NONE deposit, and BOTH effective
`commerce.financial-document.create` and `commerce.deposit-requirement.manage` permissions.
Roles never authorize it; Commerce remains authoritative.

The deposit fieldset defaults to `suggestedDepositTerms` from the projection (percentage or fixed),
or staff can enter a custom percentage or fixed amount. Text inputs preserve exact decimal strings;
fixed currency comes only from the financial projection. No local deposit amount is calculated.
Native forms retain both override inputs; enhancement reveals/enables the selected override.

The form posts the reviewed `expectedVersion`, deposit choice/override values, and a small reviewed
suggestion type/value snapshot to `?/issueProposal`. Duplicate, unexpected and file fields are
rejected. No identifiers, currency, prices, resolved amount or backend JSON are posted. The action
checks both permissions before backend access, validates the form, and reads this route's projection
once. It verifies canonical coherence and eligibility, compares a selected suggestion to the reviewed
snapshot, then calls `POST /staff/requests/{inquiryId}/proposals` with
`{ expectedDocumentVersion, terms }`. The submitted version is unchanged even if the read sees a
newer Estimate. A changed suggestion requires review, never silent substitution. There are no retries.
Backend cookies are re-issued on the admin host.

Success uses **303 to the same clean request pathname**. The authoritative GET confirms QUOTED,
the new Quote version, the exact proposal pair and the frozen required deposit amount. No optimistic
POST-response state or follow-up browser fetch is used. Refresh cannot repeat issuance.
Issuance does not imply communication delivery, customer acceptance or a payment link.

Invalid staff terms and backend 400/422 term refusals give safe associated inline feedback and allow
correction, retaining the reviewed version, suggestion, selection and exact input strings. If native
failed-POST rendering reveals changed reviewed state, correction is blocked until a clean GET.
Conflicts/state failures require explicit reload/review. Mutation timeout/network/5xx can happen after
commit, so they show ambiguous copy and block further attempts until reload. Enhanced failures retain
the reviewed projection; native failures may render newer data but never allow replay. Backend
messages never appear in user copy.

QUOTED shows the authoritative frozen amount, approved terms and current deposit status. Later
BOOKED/SERVED/CLOSED Invoices retain the historical accepted proposal/deposit pair as **Booking
deposit**; a refund making current satisfaction false does not undo booking or invalidate presentation.
Lifecycle remains exclusively driven by the inquiry. Missing or contradictory proposal/deposit fields
make the workspace unavailable. Quote/deposit revisions and payment controls are not implemented.

## Shell and limits

Requests is visually current on detail routes while its index remains non-navigable. Dashboard is
no longer current there; Back to dashboard and sign-out remain available. The inbox, staff notes,
Decline, quote editing, communications, and booking/payment workflows are outside this slice.

Historical selection display names are the remaining product-data limitation; a later contract can
provide pinned labels. A later booking-details slice can replace intentional booking-detail copy
with authoritative values.

## Coverage

Unit tests cover clients, route scoping, permissions, reviewed-version preservation, redirects,
failures, and presentation. Desktop/mobile E2E has session-isolated projections and mutation counters,
including stale versions and commit followed by 500. Native forms verify PRG and blocked conflicts.

## Implementation and validation

The response fields actually used are:

- Inquiry: `id`, `name`, `email`, `message`, `createdAt`, `zipCode`, `eventDate`, `eventType`,
  `lifecycle.documentId/stage`, and all original `pricingInputs` fields.
- Proposal/deposit: latest issuance ownership/version, active deposit revision/approval version, approved terms, frozen money and current satisfaction; backend-supplied suggested terms.
- Financial: `id`, `inquiryId`, `version`, `stage`, ordered line `id/description/subDescription/quantity/unitPrice/total/currency`,
  `subtotal`, `taxAmount`, `total`, `currency`, and `reconciliation.balance/currency`.

The contract and eligibility/coherence helpers are hand-maintained typed transport. Deposit form
validation and presentation helpers live beside them; the request route and its deposit controls
share the reviewed snapshot shape. Session-isolated fixtures exercise the same canonical projection.

Validation commands for this slice (Node v26.9.0): `npm run check`, `npm run lint`,
`npm run test:unit -- --run`, `npm run test:e2e`, and `git diff --check`. Check must have zero
errors and warnings; inspect desktop/mobile request workspace captures. Current run results belong
in the implementation report rather than carrying forward earlier slice totals.

The natural next staff workflow is the payment-to-book slice, once its authoritative facts
are available; it can reuse this workspace and replace the intentional booking-detail copy.
