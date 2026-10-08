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

## Issue Quote (quote builder)

Issue Quote is one atomic approval: Quote + explicit deposit requirement + durable proposal issuance
(+ the Quote's immutable service plan). It requires REQUESTED + ESTIMATE, no proposal, a NONE deposit
and BOTH effective `commerce.financial-document.create` and `commerce.deposit-requirement.manage`
permissions. Roles never authorize it; Commerce remains authoritative.

**Build quote** in the Right-now card opens the **Formal quote** panel inline (`?quote`, so it survives
reload and works without JavaScript). Only then does `load` read the selection choices: names, limits
and availability from `GET /offering-catalog` (DISABLED offerings dropped, UNAVAILABLE shown but not
selectable) and service durations plus the guest minimum from `GET /inquiry-form`, found by submission
pointer. If either read fails the service stays read-only and only the Estimate's lines can be adjusted.
No offering, price or limit is named in code (`src/catalog-hardcoding.test.ts`).

Staff compose **intent**, never amounts:

- **What you'll serve**: guests, minimum flag, scooping time and catalog pick chips. Unchanged service
  keeps the Estimate (`KEEP_ESTIMATE`). Guests, minimum or duration changes reprice the whole quote from
  today's catalog (`REPRICE_CONFIGURATION`). Pick-only changes preview as `REVISE_SERVICE_SELECTIONS`;
  if Commerce answers `SERVICE_SELECTIONS_CHANGE_PRICING` the action previews once more as a reprice and
  says so. The effective configuration is `financial.pricing`, else the inquiry's requested inputs for
  Estimate v1; otherwise the service is not editable. Write-ins do not exist.
- **Lines**: each service line's amount is an override of its final flat amount with a required reason.
  Targets come from the preview line's provenance: the persisted line id while the Estimate is kept, the
  generated source (base service, ice cream service, extra toppings, selected offering) when repricing.
  Overrides that no longer fit the mode are dropped and staff are told. Estimate lines cannot be renamed
  or removed.
- **+ Add line**: CHARGE, DISCOUNT or CREDIT adjustments (name, positive amount, optional detail, reason)
  with a request-local `clientKey`. Without JavaScript one blank row is always offered; blank rows are
  ignored.
- **Deposit**: the existing suggested / custom percentage / fixed choice. Fixed currency comes from the
  projection.

`?/previewQuote` checks permissions, strictly parses the envelope, reads this route's projection once,
checks coherence, eligibility and the reviewed suggestion, then calls the write-free
`POST /staff/requests/{inquiryId}/quote-preview` with the reviewed `expectedDocumentVersion`. The panel
renders only the preview: lines with their provenance and "Was $X" originals, total (with the
Estimate's for comparison), pricing-basis note and the resolved deposit. Nothing is summed in the browser.
With JavaScript the preview refreshes about 600 ms after edits (aborting stale requests); without it,
**Update preview** posts the same form. Violation codes map to builder sections with staff copy;
`CATALOG_REVISION_STALE` reloads the choices and asks for another preview; a 5xx may be retried because
nothing was written.

`?/issueQuote` rebuilds the command from the posted form and requires it to be exactly what was
previewed: same pricing basis (a REVISE previewed as REPRICE stays REPRICE) and the same SHA-256
fingerprint of version, composition and terms. Anything else previews again and needs a new explicit
click, so an edit made after the preview can never be issued silently. It then calls
`POST /staff/requests/{inquiryId}/proposals` once with `expectedDocumentVersion`, `terms`, `composition`
and the preview's `reviewToken`. `QUOTE_REVIEW_STALE` shows the new preview and requires another
approval; a 422 or stale catalog is correctable; conflicts and refusals require reload/review; timeouts,
network failures and 5xx are ambiguous (commit may have happened) and block further attempts until a
clean GET. There are no retries. With JavaScript, **Issue quote** stays disabled until the current edits
have a fresh preview. Backend messages never appear in user copy.

Success uses **303 to the same clean request pathname**. The authoritative GET confirms QUOTED, the new
Quote version, the exact proposal pair, the frozen required deposit and the `servicePlan`. The plan's
service (reviewed catalog names) is shown as **What you'll serve**, and each Quote line notes
"Negotiated · reason" or "Charge/Discount/Credit · reason". A contradictory plan makes the workspace
unavailable; an absent plan (deposit-only issuance) is legitimate. Issuance does not imply communication
delivery, customer acceptance or a payment link: there is no expiry, message or "Send" yet.

QUOTED shows the authoritative frozen amount, approved terms and current deposit status. Later
BOOKED/SERVED/CLOSED Invoices retain the historical accepted proposal/deposit pair as **Booking
deposit**; a refund making current satisfaction false does not undo booking or invalidate presentation.
Lifecycle remains exclusively driven by the inquiry. Missing or contradictory proposal/deposit fields
make the workspace unavailable. Quote/deposit revisions are not implemented.

## Manual payments and booking

QUOTED + QUOTE with the current coherent proposal, active unsatisfied deposit and
`commerce.payment.record` exposes **Record deposit**. The amount is frozen, displayed in the
summary and never editable or posted. Staff select only Cash, Check or Other. A deposit must be
recorded in full; renegotiating the requirement belongs to the proposal workflow.

The form posts only reviewed document version, proposal ID and method to `?/recordDeposit`.
The action checks the effective payment permission, strictly parses the envelope and reads the
route's coherent projection. It rejects changed review tokens or nonpayable state before mutation.
Document ID and exact required amount come from that projection. It calls
`POST /financial-documents/{documentId}/payments` once with the reviewed version and proposal ID.
USER cookies and trusted Origin follow the existing server client; returned cookies are re-issued.
`receivedAt` and `externalReference` are omitted. Backend acceptance atomically books the inquiry
and promotes the Quote to an Invoice; the frontend never changes lifecycle or calculates settlement.

Success redirects **303 to the clean request pathname**; the GET confirms BOOKED, Invoice version,
deposit context, balance and payment histories. A customer handing over $400 against a $300 deposit
requires two explicit actions: record $300 deposit, review the reloaded Invoice, then record $100.
There is no combined payment operation or independent Mark booked control.

BOOKED/SERVED + INVOICE with positive balance and payment permission exposes **Record payment**.
Its amount is an exact text input; positive values up to the authoritative balance are accepted at
the currency's normal minor-unit precision. BigInt comparisons validate input only, never compute
settlement. The form posts amount, manual method and reviewed Invoice version. The action re-reads
and checks eligibility/version/balance, derives document identity/currency and omits proposal ID.
The mutation again PRGs to confirmation. Paid and CLOSED requests have no payment action.

Local Invoice amount errors permit correction with the reviewed tokens retained. If a native
failed POST renders changed reviewed state, correction is blocked until a clean GET. Stale state,
backend refusals and ambiguous mutation timeout/network/5xx outcomes disable payment controls and
offer **Reload to review**. A 500 can follow commit; neither action ever retries. A pre-mutation read
failure uses different copy because no payment was attempted. Backend messages are never displayed.

Payment history uses only `staffRequest.payments` from the same coherent read, with no second
payment-history GET. It shows original received amount, humanized method and Pacific receipt time,
plus backend `totalRefunded`/`netReceived` when refunded. Unknown transport methods render safely.
Original allocations are selected by document ID, including historical Quote versions; other
lineages' allocations are not presented as money applied here. Refunds never erase the original
receipt or reopen a deposit action after booking. History/deposit remain readable without payment
permission; Administrator/proposal permissions do not substitute for payment permission.

Transport types include the complete payment, allocations, refunds, refund allocations and
reconciliation. Runtime checks cover the receipt/allocation fields actually rendered, alongside
the existing canonical proposal/deposit checks. Missing/malformed consumed fields fail closed.

## Explicit fulfillment and closeout

BOOKED + INVOICE with `fionas.inquiries.manage` exposes **Mark event served**. Serving is an
explicit staff action; `eventDate` never advances lifecycle or restricts eligibility. Serving does
not require financial settlement. SERVED Invoices retain **Record payment** when the authoritative
balance is positive and the account has the independent payment permission.

SERVED + INVOICE exposes **Close event** only with the fulfillment permission and an exact-zero
authoritative reconciliation balance. Decimal-string comparison accepts zero at any supplied
precision without floating-point conversion or rounding. Positive and negative balances both block
closure; a credit is not settlement. The financial ledger remains authoritative. CLOSED hides all
payment and fulfillment entry while retaining financial, deposit and payment history. Optional
served/closed occurrence times use Pacific staff formatting without principal-ID lookups.

The empty forms post to `?/markServed` and `?/closeInquiry`. The actions check session and effective
permission before backend access, reject all form fields, re-read this route's staff-request
projection and validate coherence and current eligibility. They issue exactly one bodyless POST to
`/inquiries/{inquiryId}/served` or `/close`; no dates, balances, financial identities, actors or times
are submitted. USER cookies and trusted Origin use the shared backend client; returned cookies are
re-issued on the admin host.

The POST mutation response is never page state. Success confirms through **303 to the clean request
pathname + coherent GET**, with no optimistic lifecycle changes. Pre-mutation read failures use
review-failure copy. Conflicts and refusals require reload/review; mutation network/timeout/5xx
outcomes use ambiguous copy because commit may already have occurred. Neither mutation is ever
automatically retried. Native failed-POST rendering and enhancement both block payment/fulfillment
attempts until clean reload/review. Enhanced forms also coordinate pending state and prevent double
submission across payment and fulfillment controls.

## Shell and limits

Requests is visually current on detail routes while its index remains non-navigable. Dashboard is
no longer current there; Back to dashboard and sign-out remain available. The inbox, staff notes,
Decline, quote revisions, quote expiry and messages, the phone/in-person New quote screen, communications, refunds/allocation management, electronic payment flows,
backdating and payment notes are outside this slice.

Historical selection display names remain identifiers for the original request; an issued composed
Quote shows its service plan's reviewed names. A later booking-details slice can replace intentional booking-detail copy
with authoritative values.

## Coverage

Unit tests cover clients, route scoping, permissions, reviewed-version preservation, redirects,
failures, and presentation. Desktop/mobile E2E has session-isolated projections and mutation counters,
including stale versions/proposals and deposit/Invoice commit followed by 500. Native and enhanced
forms verify PRG, blocked conflicts, fixed deposit amount, the separate deposit/additional-payment
workflow, partial Invoice payments, permission-aware controls and refunded historical receipts.
The quote builder's E2E stub (`e2e/quote-stub.mjs`, `e2e/catalog-fixture.mjs`) mirrors the preview and
composed issuance contracts with fixture-only arithmetic; specs cover overrides with reasons, added
discounts, priced and unpriced pick swaps, guest repricing with source overrides, stale reviews, failed
and stale-catalog previews, a read-only menu outage and the native form path.

## Implementation and validation

The response fields actually used are:

- Inquiry: `id`, `name`, `email`, `message`, `createdAt`, `zipCode`, `eventDate`, `eventType`,
  `lifecycle.documentId/stage`, and all original `pricingInputs` fields.
- Proposal/deposit: latest issuance ownership/version, active deposit revision/approval version, approved terms, frozen money and current satisfaction; backend-supplied suggested terms.
- Service plan: `documentId/documentVersion`, `service` (guests, duration, selection names) and
  `lines.lineItemId/origin/overrideReason`.
- Quote preview: identity, `reviewedDocumentVersion`, `pricingBasis`, `estimateTotal`, `service`, ordered
  lines with `lineItemId/origin/override/description/subDescription/quantity/unitPrice/total`, `total`,
  `deposit.terms/requiredAmount` and `reviewToken`.
- Choices: catalog `revision` and categories (`key/displayName/minimumSelections/maximumSelections`, offering
  `key/displayName/selectionState/availability/badge/statusNote`); inquiry-form guest minimum and duration
  options.
- Financial: `id`, `inquiryId`, `version`, `stage`, ordered line `id/description/subDescription/quantity/unitPrice/total/currency`,
  `subtotal`, `taxAmount`, `total`, `currency`, and `reconciliation.balance/currency`.
- Payments: `payment.paymentId/method/amount/currency/receivedAt`,
  `allocations.allocationId/documentId/documentVersion/amount/currency`, and
  `reconciliation.totalRefunded/netReceived/currency`.

The contract and eligibility/coherence helpers are hand-maintained typed transport. Deposit form
validation and presentation helpers live beside them; the request route and its deposit controls
share the reviewed snapshot shape. Session-isolated fixtures exercise the same canonical projection.

Validation commands for this slice (Node v26.9.0): `npm run check`, `npm run lint`,
`npm run test:unit -- --run`, `npm run test:e2e`, and `git diff --check`. Check must have zero
errors and warnings; inspect desktop/mobile request workspace captures. Current run results belong
in the implementation report rather than carrying forward earlier slice totals.
