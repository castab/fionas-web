# Staff request workspace

Dashboard request cards link to authenticated `/requests/{inquiryId}`. Each load sets
`Cache-Control: no-store` and reads exactly one `GET /staff/requests/{inquiryId}` through
`src/lib/server/staff-request.ts` and `backend.ts`. The hook separately resolves the USER session
via `/auth/me`. No browser-to-commerce calls or inquiry/document/catalog enrichment reads occur.

## Presentation boundary

The header and lifecycle strip use `inquiry.lifecycle.stage` exclusively. The workspace presents
name/email, submission date, date-only event date, type, ZIP, guests/minimum flag, and
escaped notes. The original requested service shows recorded human-readable item labels.
Financial lines describe charges; the approved plan separately describes what Fiona will serve.

There is no collection workflow for the full event address or event contact yet; recording the
deposit books the inquiry without one. Their rows say **Not on file**, at every stage, rather than
implying a step that never happens. ZIP remains the coarse inquiry location. No details are
inferred from messages.

The Serving plan renders backend-ordered financial lines, quantities, unit prices, line totals,
subtotal, tax, total and stage/version; only an Invoice shows its reconciliation balance. Once an
approved plan exists it appears inside the Serving plan ("What you'll serve") and replaces the
customer's original picks on the page. Exact decimal strings go directly to Intl formatting; no
repricing or financial arithmetic occurs. Missing reconciliation or inconsistent document ownership
is unavailable rather than an assumed zero balance.

**Right now** words the current stage for staff. Its headline and description come from
`requestSummary`/`requestSummaryDescription` with the business-timezone date the load supplies
(`businessDate`), so a countdown ("scooping in 25 days") never depends on the host or browser
clock. Its figures are backend values only: Estimate or Quote total and the active deposit while
QUOTED; Invoice total, `reconciliation.netApplied` (Paid) and balance afterwards. Its action row
holds Build quote / Decline, Mark event served / Close event, and Record deposit / Record payment.
Payment entry opens below the card from `?payment` (a plain link, so it works without JavaScript)
or stays open while a returned payment result is shown; success PRGs to the clean path, which
closes it.

## Issue Quote (quote builder)

Staff USER sessions flow through backend.ts with the host-only __Host-fionas_session cookie and trusted Origin. Issue quote requires commerce.financial-document.create, commerce.deposit-requirement.manage and fionas.financial-terms.manage. Only staff USER sessions author staff terms; the public site holds no commerce credentials at all. The admin works without a public price book.

The inline editor opens with a preview of complete existing financial lines under their immutable ids. Staff can override descriptions, quantity, unit price and whole-line tax; remove/reorder existing lines; add bespoke services or distinct signed charges/discounts/credits with stable draft keys. Negative adjustments are separate lines. Optional servicePlan descriptions, guest counts, free-form items and identity-bound lineNotes preserve the approved service and negotiation reasons. In the browser each line is a summary row (title, origin tag, price) that opens into one editor at a time (`quote-lines-editor.svelte`): quantity or flat pricing, discounts and credits typed as a positive amount off and submitted as a negative `unitPrice`, and a collapsible Tax & note. Lines are added by kind (Service, Charge, Discount, Credit). Collapsed editors stay in the form, so every line is always submitted; without JavaScript every line is open and a trailing blank row adds one. There is no catalog dependency. requestedService displays the customer's recorded human-readable labels; linesAuthoredBy, issuedBy and approvedBy represent backend authorship.

Preview posts expectedDocumentVersion, lines, optional servicePlan and terms without rereading the request. It is write-free and repeatable. The browser acknowledges edits but never calculates Quote totals or deposit. Native forms expose blank rows plus remove/reorder buttons and explicit Update preview; enhanced forms preview edits after a short delay. Exact input validation rejects unsupported precision and nonsettleable rate extensions without rounding.

**USD only.** Fiona's Ice Cream operates exclusively in US dollars (`$lib/currency.ts`). Commerce is currency-generic by design; this console is not, and it never converts or offers a currency choice. Flat prices and line tax must be whole cents; a per-unit rate may carry up to 12 fractional digits when rate × quantity settles exactly to cents; amounts may be signed for discounts and credits; nothing is rounded. Validation always applies USD rules, never a currency posted by the browser: the page's echoed `reviewedCurrency` must be `USD` or the form is refused before any preview, and every line is sent as USD. A request whose financial document isn't USD is not quote-eligible, so it gets no opening preview and issuance is refused, and a preview answered in another currency is rejected.

Issuance rereads the coherent authoritative request, checks its version, USD currency, deposit suggestion and permission intersection, and compares a SHA-256 fingerprint of the full ordered command/plan/terms with the reviewed form. A changed input or QUOTE_REVIEW_STALE previews again and requires another click. It sends the same lines/plan/terms and reviewToken once, never retries a mutation, and requires reload after an ambiguous outcome. A 303 to the clean path lets the authoritative GET confirm Quote, deposit and approved service plan. Issuance does not imply delivery or booking.

Quote/deposit revision controls remain outside the current UI, as before this migration; the backend's corresponding identity-bearing endpoints are not emulated. Manual payments and served/closed workflows below are retained. Current read validators reject absent/corrupt requested service, line identities/amounts/authorship, reconciliation, proposal/deposit pairs and plan notes instead of substituting zero or success.

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
Its amount is an exact text input; positive values up to the authoritative balance are accepted in
whole USD cents; any other currency is refused (no payment action is offered). BigInt comparisons validate input only, never compute
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

## Declining a request

Depends on fionas-commerce PR #27 (merged): `POST /inquiries/{inquiryId}/decline` with exactly
`{ expectedDocumentVersion, reason }`, answering `200` with the `InquiryLifecycleResponse`. The
backend takes the actor (a staff USER) and time from authentication, records `InquiryDeclined v1`
transactionally, and refuses with `403` (no `fionas.inquiries.manage`, SERVICE, untrusted Origin),
`404`, `409 conflict` (stale version, never rebased), `409 illegal_transition` (not REQUESTED,
including already declined) and `422 validation_failed` (blank or over-long reason).

**Eligibility.** `canDeclineInquiry` needs only `fionas.inquiries.manage`, independent of the Quote
permissions, and a coherent REQUESTED inquiry on its unquoted canonical Estimate (no proposal, no
deposit requirement). QUOTED, BOOKED, SERVED, CLOSED and DECLINED never offer it; withdrawing a
Quote or cancelling a booking are different actions that don't exist yet.

**Confirmation.** Decline (beside Build quote) opens an inline panel via `?decline`, a plain link
that works without JavaScript. It names the customer, event date and type, and says the request
leaves active work, its Estimate stays on file, the customer is not notified automatically, and
the console can't reopen it. **Reason for declining** is a required internal note (helper text says
so), at most 500 characters after trimming; line breaks are kept (form CRLFs count once). **Decline
request** submits; **Keep request** returns to the clean page. A blank or whitespace reason is refused
before any POST, both in the browser and by the action, with an announced error tied to the field.

**Action.** `?/declineInquiry` checks the session, then the permission, then strictly reads exactly
one `expectedDocumentVersion` and one `reason` (anything else, including ids, actors, times or
stages, is refused). It validates the reason, re-reads the route's projection, requires it to be
coherent and still eligible, and requires its Estimate version to equal the reviewed one; a changed
version is refused, never replaced. It then sends one POST with the reviewed version and the
trimmed reason, and PRGs to the clean path, whose GET is the only confirmation. The POST response is
never page state. A backend `422` is correctable (nothing was recorded). Everything else after the
attempt requires review: `5xx`, timeout or lost response say "We couldn't confirm whether this
request was declined…", because the decline may have committed. Nothing is retried.

**Blocking.** Decline failures join the workspace-wide `mutationReviewRequired`: Build quote,
Decline, the quote builder, payment entry and fulfillment are all disabled until a clean reload. The
panel's Keep request is disabled while submitting and hidden once review is required, so the warning
can't be dismissed.

**Declined requests.** The validator accepts DECLINED only with structurally valid provenance
(`declined` present exactly at DECLINED: instant, USER, principal id, trimmed 1–500 character reason,
`documentVersion` equal to the canonical Estimate version) beside an Estimate with no proposal,
deposit requirement, service plan or served/closed facts. Anything else is unavailable, never read as
REQUESTED. The page shows a rust **Declined** badge; the progress strip keeps the five booking steps
with Requested done and the rest struck through as skipped (none current), since DECLINED is a
terminal alternative, not a step after Closed. Right now reads **Request declined** with the decline
time and no pending action, and labels the figure "Declined estimate" (no balance or amount owed). A
**Decline decision** card shows the time (Pacific), the internal reason, "You" or "Staff" plus the
principal id as audit detail (no names are looked up), and the reviewed Estimate version. Customer
details, requested service, notes, the Estimate and any payment history stay readable; no Quote,
decline, payment or fulfillment action is offered. The dashboard drops declined inquiries because
the backend excludes them from every queue and count; the frontend reconstructs nothing.

## Shell and limits

Requests is visually current on detail routes while its index remains non-navigable. Dashboard is
no longer current there; Back to dashboard and sign-out remain available. The inbox, staff notes,
reopening declined requests, quote revisions, quote expiry and messages, the phone/in-person New quote screen, communications, refunds/allocation management, electronic payment flows,
backdating and payment notes are outside this slice.

The original request retains its recorded human-readable selection labels; an issued
Quote shows the approved free-form service plan. A later booking-details slice can replace intentional booking-detail copy
with authoritative values.

## Coverage

Unit tests cover clients, route scoping, permissions, reviewed-version preservation, redirects,
failures, and presentation. Desktop/mobile E2E has session-isolated projections and mutation counters,
including stale versions/proposals and deposit/Invoice commit followed by 500. Decline E2E covers
native and enhanced confirmation, Keep request, blank reasons, keyboard-only submission, exact request
bodies (including later Estimate versions), stale, conflicting and committed-then-500 outcomes,
permission and QUOTED refusals by direct POST, and the read-only declined workspace. Native and enhanced
forms verify PRG, blocked conflicts, fixed deposit amount, the separate deposit/additional-payment
workflow, partial Invoice payments, permission-aware controls and refunded historical receipts.
The quote builder's E2E stub resolves complete ordered lines and money-free service plans, preserves existing ids and derives new ids from stable keys. Desktop/mobile tests cover overrides, removals, reordering, bespoke services, credits, native and enhanced preview/issuance, permissions, stale reviews and ambiguous outcomes.

## Implementation and validation

The response fields actually used are:

- Inquiry: `id`, `name`, `email`, `message`, `createdAt`, `zipCode`, `eventDate`, `eventType`,
  `lifecycle.documentId/stage`, and the descriptive original `requestedService`.
- Proposal/deposit: latest issuance ownership/version, active deposit revision/approval version, approved terms, frozen money and current satisfaction; backend-supplied suggested terms.
- Service plan: description, optional guests, free-form items, final identity-bound lineNotes, document/reviewed versions and approvedBy/approvedAt.
- Quote preview: document/inquiry identity, reviewedDocumentVersion, estimateTotal, financialChange, quoteVersion, ordered lines with id/origin/key and exact money, deposit terms/requiredAmount, optional servicePlan and reviewToken.
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

## Categorized service selections

Commerce PR #28 made approved service-plan selections structured: `ServicePlanItem { label, group?,
key? }` in `ServicePlanRequest`, the preview's `servicePlan` and `ServicePlanResponse`
(`$lib/quote-contract.ts`). The label is required (200 characters); the optional group and source
key allow 120 each. A plan holds zero to 50 ordered selections, duplicates included. Commerce trims
text and stores blank metadata as null; legacy string arrays fail closed in `isCoherentServicePlan`
and `isQuotePreview`. The customer's original picks (`RequestedItem`, same shape) are checked only
for what rendering needs, because the inquiry contract sets no length or count limits.

**Original intent and the approved commitment are independent.** "What they asked for" renders
`inquiry.requestedService.items` exactly as recorded and keeps the existing visibility policy
(hidden once an approved plan exists; customer notes stay). The serving plan renders only the
backend's approved `servicePlan.items`, including an accepted Quote's plan after promotion to
Invoice; it is never rebuilt from Invoice lines. Neither reads a catalog or the public menu.

**Grouping** (`selectionGroups`, `categorized-selections.svelte`) is presentation only and shared by
the original request, the quote preview and the approved plan. Categories appear in first-occurrence
order, items keep their order within a category, nothing is sorted or deduplicated, and missing or
blank categories appear under "Other selections". Each category is a heading plus a list named by
it; chips are informational, not controls.

**The editor** (`service-selections-editor.svelte`) starts from an independent copy of the
customer's picks, keeping labels, categories, keys and order. Each row has a label and a free-form
category (suggested from categories already in the draft), Move up/Move down across the overall
order (positions are numbered), and Remove; "+ Add selection" adds a custom row with no key. A blank
untouched row is ignored; a row with a category but no label is an error. Editor row IDs are UI
identities, never sent to commerce and unrelated to the opaque `key`. The command carries a row's key
only while its label equals the label the key came with, so a substitution drops its provenance
(restoring the label restores it). Nothing in a selection selects a price.

Enhanced: selections show as removable chips under their category headings. Remove drops a chip;
"+ Add selection" opens a composer (label, optional category suggested from the draft; Enter adds
without submitting the quote form) and appends a keyless selection. Chips carry the same hidden
`selectionIdentity`/label/group/key/source fields, edits feed the debounced preview, and order follows
the draft (original picks first, additions after). Renaming or regrouping is a remove plus add, which
drops provenance as above. Native: every row posts
`selectionIdentity` (the overall order) plus exactly one `selectionLabel:`, `selectionGroup:`,
`selectionKey:` and `selectionSource:` field per unique ID. Selection buttons post `selectionAction`
(`add`, `remove:<id>`, `up:<id>`, `down:<id>`), separate from financial `rowAction`; the server
returns the complete draft (lines, notes, deposit, description, guests, selections) with the review
cleared, and Update preview is the explicit next step. Malformed envelopes are refused with 422. With
no service description, the builder says no serving plan or selections will accompany the Quote.

**Review integrity.** The local SHA-256 fingerprint covers the canonical command, including every
selection's label, group, key and position, but no editor IDs; label, category-only, key-only,
reorder, add and remove edits all require a fresh preview even when input handlers are bypassed.
A preview whose selections differ from the proposed ones is refused (503). Commerce's v3 review
token independently binds the same facts. Issuance remains one attempt followed by the authoritative
GET; financial lines, totals, deposits and permissions keep their existing authority.
