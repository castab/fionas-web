# Staff request workspace

Dashboard request cards link to authenticated `/requests/{inquiryId}`. Each load sets
`Cache-Control: no-store` and reads exactly one `GET /staff/requests/{inquiryId}` through
`src/lib/server/staff-request.ts` and `backend.ts`. The hook separately resolves the USER session
via `/auth/me`. No browser-to-commerce calls or inquiry/document/catalog enrichment reads occur.

## Presentation boundary

The header and lifecycle strip use `inquiry.lifecycle.stage` exclusively. The workspace presents
name/email, submission date, date-only event date, type, ZIP, guests/minimum flag, duration, and
escaped notes. The original requested service shows recorded human-readable item labels.
Financial lines describe charges; the approved plan separately describes what Fiona will serve.

Full event address and event-contact details are intentionally collected later when booking.
Their rows say **Collected when booking**: workflow copy, not a missing-data error or placeholder
domain model. ZIP remains the coarse inquiry location. No details are inferred from messages.

The Serving plan renders backend-ordered financial lines, quantities, unit prices, line totals,
subtotal, tax, total, currency, stage/version, and reconciliation balance. Exact decimal strings go
directly to Intl formatting; no repricing or financial arithmetic occurs. Missing reconciliation or
inconsistent document ownership is unavailable rather than an assumed zero balance.

## Issue Quote (quote builder)

Staff USER sessions flow through backend.ts with the host-only __Host-fionas_session cookie and trusted Origin. Issue quote requires commerce.financial-document.create, commerce.deposit-requirement.manage and fionas.financial-terms.manage. Public SERVICE credentials never author staff terms. The admin works without a public price book.

The inline editor opens with a preview of complete existing financial lines under their immutable ids. Staff can override descriptions, quantity, unit price and whole-line tax; remove/reorder existing lines; add bespoke services or distinct signed charges/discounts/credits with stable draft keys. Negative adjustments are separate lines. Optional servicePlan descriptions, guest/duration counts, free-form items and identity-bound lineNotes preserve the approved service and negotiation reasons. There is no catalog dependency. requestedService displays the customer's recorded human-readable labels; linesAuthoredBy, issuedBy and approvedBy represent backend authorship.

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

## Shell and limits

Requests is visually current on detail routes while its index remains non-navigable. Dashboard is
no longer current there; Back to dashboard and sign-out remain available. The inbox, staff notes,
Decline, quote revisions, quote expiry and messages, the phone/in-person New quote screen, communications, refunds/allocation management, electronic payment flows,
backdating and payment notes are outside this slice.

The original request retains its recorded human-readable selection labels; an issued
Quote shows the approved free-form service plan. A later booking-details slice can replace intentional booking-detail copy
with authoritative values.

## Coverage

Unit tests cover clients, route scoping, permissions, reviewed-version preservation, redirects,
failures, and presentation. Desktop/mobile E2E has session-isolated projections and mutation counters,
including stale versions/proposals and deposit/Invoice commit followed by 500. Native and enhanced
forms verify PRG, blocked conflicts, fixed deposit amount, the separate deposit/additional-payment
workflow, partial Invoice payments, permission-aware controls and refunded historical receipts.
The quote builder's E2E stub resolves complete ordered lines and money-free service plans, preserves existing ids and derives new ids from stable keys. Desktop/mobile tests cover overrides, removals, reordering, bespoke services, credits, native and enhanced preview/issuance, permissions, stale reviews and ambiguous outcomes.

## Implementation and validation

The response fields actually used are:

- Inquiry: `id`, `name`, `email`, `message`, `createdAt`, `zipCode`, `eventDate`, `eventType`,
  `lifecycle.documentId/stage`, and the descriptive original `requestedService`.
- Proposal/deposit: latest issuance ownership/version, active deposit revision/approval version, approved terms, frozen money and current satisfaction; backend-supplied suggested terms.
- Service plan: description, optional guests/duration, free-form items, final identity-bound lineNotes, document/reviewed versions and approvedBy/approvedAt.
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
