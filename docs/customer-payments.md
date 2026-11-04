# Customer booking & payments

Customers pay Quote deposits and Invoice balances through Stripe-hosted Checkout from one stable,
inquiry-scoped page: `/pay/{publicId}` on the public site. Staff issue and manage that link from
the request workspace. The backend contract is fionas-commerce PR #36 (merged); its
`docs/stripe-payments-frontend-handoff.md`, `docs/stripe-payments-operations.md` and executable
OpenAPI are authoritative and are deliberately not copied here.

**The frontend presents and initiates payments; it never decides that money was received.**
Commerce owns access, terms, amounts, authorizations and reconciliation; the ledger owns money.

## Where code lives

| Concern                                          | File                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Customer page                                    | `apps/public/src/routes/pay/[publicId=uuid]/`                                          |
| Page state machine (refresh, checkout, recovery) | `apps/public/src/lib/payments/controller.ts`                                           |
| Fail-closed view of the summary                  | `apps/public/src/lib/payments/view.ts`                                                 |
| Contract types and strict readers                | `apps/public/src/lib/payments/contract.ts`                                             |
| Exact USD cents (BigInt)                         | `apps/public/src/lib/payments/money.ts`                                                |
| Bearer capture, tab storage, error classes       | `apps/public/src/lib/payments/checkout.ts`                                             |
| Customer wording                                 | `apps/public/src/lib/payments/copy.ts`, `$lib/components/payments/`                    |
| Public payment BFF (the only commerce access)    | `apps/public/src/lib/server/payments/bff.server.ts`, `transport.server.ts`             |
| BFF routes                                       | `apps/public/src/routes/api/payments/[publicId=uuid]/`                                 |
| Security headers                                 | `apps/public/src/hooks.server.ts`                                                      |
| Staff link and attempt client, form action       | `apps/admin/src/lib/server/customer-payments.ts`, `$lib/customer-payments.ts`          |
| Staff Customer payments card                     | `apps/admin/src/lib/components/requests/customer-payments.svelte`                      |
| Staff diagnostics refresh endpoint               | `apps/admin/src/routes/(app)/requests/[inquiryId]/customer-payments/+server.ts`        |
| E2E stubs                                        | `apps/public/e2e/payments/stub-commerce.mjs`, `apps/admin/e2e/payment-access-stub.mjs` |

## The stable URL and bearer lifecycle

```
https://www.fionasicecream.com/pay/b8251ea0-c07c-4aad-bceb-644ed075c0a1#<43-character bearer>
                                    └ nonsecret publicId (path) ┘        └ secret (fragment) ┘
```

The fragment never reaches any server (not ours, not a CDN, not a log), so the page's server render
contains no booking data at all; the load function is empty. On the browser:

1. Read `location.hash`. It must be exactly 43 base64url characters; anything else shows
   "This payment link looks incomplete" and is never sent.
2. Store the bearer in **this tab's sessionStorage**, keyed by publicId
   (`fionas.pay.{publicId}.token`). A newer fragment replaces an older one (a rotated link).
3. Remove the fragment immediately with `history.replaceState` (SvelteKit's history state is kept;
   its `page.url` is synced right after hydration). Any `?checkout=` return marker goes too.
4. Read the summary through the same-origin BFF.

With no fragment, the page uses the bearer saved in this tab (this is how a Stripe return works).
With neither, it shows **Payment link required** and asks the customer to reopen the original link.
A 404 (unknown, rotated or revoked bearer; commerce answers all three identically) forgets the
bearer and shows "This payment link is no longer active". There is no lookup by email or name and
no credential recovery endpoint.

The bearer is never put in localStorage, cookies, query strings, server data, analytics, logs or a
global store: it lives in the page controller's closure and this tab's sessionStorage. If
sessionStorage is blocked the page still works while it stays open, and says so. A copied link
works in a new tab because it carries the fragment; a Stripe return relies on the original tab.

Opening a different link in the same tab (only the fragment changes) reloads the page from it.

## Same-origin BFF

The browser only calls the public site's own origin, with `credentials: 'omit'`:

| Browser call                                      | Forwarded to commerce                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /api/payments/{publicId}`                    | `GET /public/payments/{publicId}` (`readCustomerPaymentSummary`)                       |
| `POST /api/payments/{publicId}/checkout-sessions` | `POST /public/payments/{publicId}/checkout-sessions` (`createCustomerCheckoutSession`) |

Exactly two narrow endpoints, not a proxy. Before any commerce call the BFF validates the UUID,
exactly one 43-character `X-Fionas-Payment-Token`, and (POST) a same-origin `Origin`,
`Sec-Fetch-Site` when present, `application/json`, an `Idempotency-Key` of 1–128
`[A-Za-z0-9_-]`, a body of at most 1 KiB, and a command of exactly `expectedDocumentVersion`,
`expectedBusinessRevision` and optional integer `amountMinor` (50–99,999,999). Anything else
(currency, totals, purpose, terms, proposal ids) is refused. The command is re-serialized
canonically.

Commerce receives only `Accept`, the bearer, and for checkout `Content-Type` and
`Idempotency-Key`: never site cookies, a staff session, a SERVICE token or any other browser
header. Redirects are not followed. Responses are re-built from the documented customer-safe
fields (unknown fields are dropped) and validated; error bodies keep only the stable `code` plus a
known conflict message (`PAYMENT_TERMS_CHANGED`, `CHECKOUT_KEY_REUSED`, `RECONCILIATION_PENDING`).
Backend message text never reaches the customer.

| Commerce outcome                       | BFF answer                 | Customer meaning            |
| -------------------------------------- | -------------------------- | --------------------------- |
| 200 valid                              | 200 (whitelisted)          | render / redirect           |
| 200 malformed                          | 502 `invalid_response`     | unknown outcome             |
| 400 / 404 / 409 / 422                  | same status, stable code   | per the table below         |
| 503 `stripe_disabled`                  | 503 `stripe_disabled`      | online payments unavailable |
| `COMMERCE_API_URL` unset or invalid    | 503 `payments_unavailable` | online payments unavailable |
| other 5xx, redirect, unexpected status | 502 `internal_failure`     | unknown outcome (same key)  |
| timeout / connection failure           | 504 `unavailable`          | unknown outcome (same key)  |

`transport.server.ts` is the only reader of `COMMERCE_API_URL` and logs only an operation name, a
status and a failure kind: never the URL, bearer, key, body or publicId. It never imports NATS or
inquiry submission code (`server-boundary.test.ts` enforces both).

**Headers.** Every `/pay/*` response (including `__data.json` and error pages) and every
`/api/payments/*` response sends `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
`X-Robots-Tag: noindex, nofollow`, `Content-Security-Policy: frame-ancestors 'none'` and
`X-Content-Type-Options: nosniff`. The page also has robots and referrer meta tags and turns off
SvelteKit link preloading. No third-party script, analytics, Stripe.js or service worker runs here.

**No JavaScript.** Authorization arrives in the fragment, so the flow needs JavaScript. Without it
the page shows a branded explanation with the contact email; secrets never move to query strings.

## Page states

`paymentView(summary)` derives what the customer can do; anything unknown fails closed:

| Summary                                                            | View             | Action                                  |
| ------------------------------------------------------------------ | ---------------- | --------------------------------------- |
| QUOTED, DEPOSIT, QUOTE, canPay                                     | `deposit-due`    | Pay the exact deposit (no amount input) |
| BOOKED/SERVED, INVOICE, INVOICE, canPay                            | `balance-due`    | Pay the balance, or a different amount  |
| `paymentInProgress`                                                | `in-progress`    | Wait (polled); optional recovery check  |
| `reconciliationPending`                                            | `reconciliation` | Contact staff; no collection            |
| `NO_PAYMENT_DUE`                                                   | `no-balance`     | Paid up, or a credit                    |
| `CLOSED`                                                           | `closed`         | Read-only history                       |
| `BELOW_STRIPE_MINIMUM` / deposit `ABOVE_STRIPE_MAXIMUM`            | `staff-assist`   | Contact staff                           |
| `NOT_PUBLISHED`                                                    | `not-ready`      | Wait for the quote                      |
| `UNSUPPORTED_CURRENCY`, unknown reason/lifecycle/mode, incoherence | `unavailable`    | Contact staff                           |

Page phases around it: initializing, link required, link incomplete, link unavailable, backend
unreachable (with Try again) and online payments unavailable. Busy states (`submitting`,
`redirecting`) disable the action. Labels use `document.businessRevision` ("Quote v4",
"Invoice v8"; "Booked from Quote v4" from `acceptedQuoteRevision`); `document.version` is only
sent back as `expectedDocumentVersion`. Figures come straight from the summary: total, payments
applied, remaining balance (or credit), the deposit while QUOTED, a whole-percent progress bar
after booking (presentation only), and receipts with refunded amounts. No line items, taxes,
service details, names, receipts or PDFs are invented.

**Exact money.** Decimal strings become BigInt cents (`decimalToCents`); a value that isn't whole
cents makes the summary invalid rather than rounded. Partial input accepts `250`, `250.5`,
`$1,250.00`, refuses more than two decimals, and must be at least $0.50, at most $999,999.99 and
at most the balance. A balance above the Stripe maximum disables the full option and requires a
partial; a balance below the minimum asks for staff help.

## Checkout idempotency

A deliberate Pay click freezes the reviewed `document.version`, `businessRevision` and amount,
generates one `crypto.randomUUID()` key, and **saves the key and exact body in sessionStorage
before sending** (`fionas.pay.{publicId}.checkout`). Double clicks are ignored in the controller
(not only by disabling the button), and while a saved command exists the ordinary Pay is hidden.

| Result                                                           | Handling                                                                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 200 OPEN with a `https://checkout.stripe.com` URL                | mark the command redirected, navigate this tab (URL never stored)                 |
| 200 without a valid URL                                          | refresh; the summary decides (OPEN → "earlier checkout still open")               |
| 200 EXPIRED / FAILED                                             | historical replay: forget the command, ask for a new deliberate payment           |
| network failure, timeout, 5xx                                    | retry the **same key and bytes** after 1.5 s and 4 s, then "Try again" (same key) |
| 409 `PAYMENT_TERMS_CHANGED`                                      | forget the key, refresh, "Your booking was updated"; next click is a new key      |
| 409 `CHECKOUT_KEY_REUSED`                                        | keep and block the command; only a deliberate **Start over** discards it          |
| 409 recovery codes (below)                                       | no key was claimed: forget it, refresh, explain; never an automatic retry         |
| 409 `RECONCILIATION_PENDING`, `checkout_reconciliation_required` | contact staff                                                                     |
| 422 / 400                                                        | forget the key, explain; the customer may try deliberately                        |
| 404                                                              | link no longer active                                                             |
| 503 `stripe_disabled`                                            | online payments unavailable                                                       |
| any other code                                                   | fail closed: refresh and require review                                           |

An ambiguous outcome survives a reload of the tab: the saved command stays `sending`, so the page
offers only **Try again** with the identical command. Payment is never re-authorized because a
request timed out.

## Freshness and uncertain outcomes

**Fresh summaries only.** `summaryFresh` separates a summary kept on screen for reading from one
that may back a new financial decision. It is true only after the latest read succeeded; a failed
refresh keeps the figures visible but disables Pay and fresh-key recovery behind **We couldn't
confirm your current balance, so paying is paused** with **Check again**. A summary older than five
minutes (`MAX_SUMMARY_AGE_MS`) is re-read when the customer clicks Pay: unchanged terms proceed in
the same click; changed terms (document version, business revision, purpose or amount) stop with
**Your booking was updated** for review; a failed re-read pauses paying. Resending this tab's own
saved command (Try again, resuming a cancelled Checkout) needs no fresh summary: the same key can
only reach its original authorization.

**Never a false guarantee.** `paymentUncertain` is true while this tab holds a saved command
(`sending` or `redirected`), after a Stripe return until a summary has resolved it, or when a
revoked link dropped one. Unavailability then reads **We can't confirm your payment status right
now. Please don't make another payment until we've checked it. Contact Fiona's if you need
assistance.**, for an unreachable backend, disabled payments and a failed refresh alike, and a
revoked link asks the customer to contact Fiona's before paying again. Without a possible payment,
disabled payments read "Online payments aren't available right now. Please try again later or
contact us for help." No message says a customer was or wasn't charged unless a summary shows it:
success wording needs the summary's effect, and a cancel redirect, an outage or a configuration
failure proves nothing. A `stripe_disabled` answer keeps a saved command unless it was brand new
and refused on its first attempt, because that refusal says nothing about an earlier send.

## Returning from Stripe

Commerce sends customers to `/pay/{publicId}?checkout=returned` or `?checkout=cancelled`. Neither
proves anything. The page restores the bearer, removes the marker and reads the summary:

- still `paymentInProgress` → **Confirming your payment** (returned) or **Checkout was cancelled**
  (cancelled; the Session may still be open) and polling;
- `QUOTED` → `BOOKED`/`SERVED`/`CLOSED` after a deposit → **Deposit received. Your booking is
  confirmed.** with the authoritative remaining balance;
- `paidAmount` increased after an Invoice payment → **Payment received. Your remaining balance is $X.**;
- otherwise → "Your last checkout wasn't completed".

A cancelled Checkout is never replaced just because the customer came back. Polling runs only
while a payment is underway and the page is visible, with bounded backoff (2, 3, 5, 8, 13, 20,
30, 30 s, then four 60 s reads, about six minutes), then offers **Check again**. There is no
public SSE.

## Recovery and reconciliation

While a payment is underway the ordinary Pay is disabled. When the summary's optional
`checkoutRecoveryAvailable` is true (absent means false), or this tab still holds its own
redirected command, the page offers a separate **Check previous payment and continue**:

- with this tab's original key and body: resend them, which returns the original authorization
  (back to the same open Checkout) or a historical result;
- without them (another browser, lost storage): one deliberate command with a fresh key and the
  currently reviewed versions (and, for an Invoice, the chosen amount). Commerce checks the old
  Session first and authorizes a replacement only after confirmed expiry/failure.

| Recovery code                      | Customer sees                                                    |
| ---------------------------------- | ---------------------------------------------------------------- |
| `checkout_in_progress`             | An earlier checkout is still open (expires within about an hour) |
| `payment_processing`               | A payment is being confirmed; don't start another                |
| `payment_state_changed`            | An earlier payment was recorded; review the new balance          |
| `checkout_recovery_conflict`       | Status just changed; review and retry deliberately               |
| `checkout_reconciliation_required` | A payment needs staff review; contact us                         |

None of these claims a key or starts a retry loop. `reconciliationPending` shows "We received a
payment that needs staff review. Please contact Fiona's before paying again." and offers no payment
until commerce clears it. BOOKED is shown only when commerce says BOOKED.

## Staff link management

The request workspace's **Customer payments** card sits directly under **Right now** (both in the
rail on wide layouts; before Activity when stacked). It renders only for QUOTED, BOOKED, SERVED
and CLOSED and only when the staff member has **all three** of `fionas.payment-access.manage`,
`fionas.inquiries.read` and `commerce.financial-document.read`; otherwise no backend call is made
and every other workspace capability is unchanged. The first permission is granted to no role,
Administrators included: an administrator must grant it explicitly through runtime role
administration. The console never expands grants or substitutes a SERVICE credential.

| Staff action                  | Commerce call                                                       |
| ----------------------------- | ------------------------------------------------------------------- |
| workspace load (status only)  | `GET /staff/requests/{id}/payment-access`, `GET …/payment-attempts` |
| Create / issue a new link     | `POST /staff/requests/{id}/payment-access`                          |
| Copy payment link             | `GET /staff/requests/{id}/payment-access` (deliberate, read-only)   |
| Rotate link (confirmed)       | `POST /staff/requests/{id}/payment-access/rotate`                   |
| Revoke link (confirmed)       | `POST /staff/requests/{id}/payment-access/revoke`                   |
| Check with Stripe (confirmed) | `POST /staff/requests/{id}/payment-attempts/{attemptId}/reconcile`  |

All go through `backend.ts` with the staff member's own cookie and trusted `Origin`; POSTs have no
body and are sent once (never retried; an uncertain result says **Reload to review** and blocks
the card). The workspace load exposes only `none` / `active` / `revoked` and the nonsecret
publicId: the usable URL is read only when staff click **Copy payment link**, returned only in that
action's response, validated to be exactly `…/pay/{publicId}#<43 chars>`, and written to the
clipboard (`ClipboardItem` inside the click's activation, then `writeText`). If the clipboard is
unavailable, a selectable read-only field shows it until hidden or for two minutes. Copying never
rotates or recreates the link; the same link survives Quote revisions and Invoice amendments.

Rotation and revocation each sit behind a disclosure that explains the consequence (every copy
stops working; payments already underway can still be reconciled) before the confirming button.
CLOSED bookings can copy and revoke an existing link but cannot create or rotate one. REQUESTED and
DECLINED never show the card. Stripe disabled reads "Online payments are turned off in commerce";
manual payments still work.

With JavaScript, actions are enhanced forms whose results stay inside the card: no workspace
invalidation, so reply drafts, editor drafts and disclosures are untouched. Without JavaScript the
same `?/customerPayments` action re-renders the page.

**Attempt diagnostics** (a disclosure) list purpose, authorized amount, creation time (Pacific),
the reviewed Quote/Invoice revision, provider state, reconciliation outcome, whether a ledger
payment exists and the static diagnostic code. `RECONCILIATION_REQUIRED` is highlighted in rust
with "Money reached the ledger but was not allocated automatically" and a card-level warning; it is
never presented as applied. **Check with Stripe…** appears for active or paid-but-pending attempts,
explains that it never creates a charge or allocates unapplied money, and refreshes the list. Any
provider URL in the reconcile response is dropped. Attempts are diagnostics, not ledger facts:
Activity remains the payment history, and nothing here repeats it. No refund or dispute controls.

**Live updates.** The existing timeline SSE is unchanged. After each authoritative Activity read
(`onrefreshed` on the Conversation card), Customer payments refreshes its diagnostics through
`GET /requests/{id}/customer-payments` if the attempts disclosure is open, or marks them stale for
when it opens. When the Activity history changed, the workspace also re-reads the authoritative
staff request and refreshes Right now in place (an online deposit shows BOOKED, the Invoice and
the new balance without a reload); an open review panel keeps its snapshot and says it is stale.
See [Live staff financial state](admin-request-workspace.md#live-staff-financial-state). Nothing
invalidates the whole page.

## Configuration and deployment

| App    | Variable           | Purpose                                                                                     |
| ------ | ------------------ | ------------------------------------------------------------------------------------------- |
| public | `COMMERCE_API_URL` | Commerce origin for the payment BFF only (bare http(s) origin). Unset: payments unavailable |
| public | `ORIGIN`           | adapter-node's public origin; must match the browser's, or checkout POSTs are refused (403) |
| admin  | `COMMERCE_API_URL` | Unchanged; the staff link endpoints use it                                                  |

The public app holds no Stripe key, webhook secret, `FIONAS_PAYMENT_ACCESS_KEY`, staff credential
or session; never configure them in fionas-web. In commerce, `FIONAS_PUBLIC_BASE_URL` must be this
public site's exact origin (the one serving `/pay/{publicId}`), so issued links and Stripe return
URLs point here.

**Local.** Run commerce on `http://localhost:8080` with `FIONAS_STRIPE_ENABLED=true`,
`FIONAS_STRIPE_LIVE_MODE=false`, a `sk_test_` key and `FIONAS_PUBLIC_BASE_URL=http://localhost:5173`
(test mode allows localhost). Set `COMMERCE_API_URL=http://localhost:8080` in `apps/public/.env`,
`npm run dev` and `npm run dev:admin`, grant your staff role `fionas.payment-access.manage`, then
issue and copy a link from a quoted request. The booking form (NATS) is independent: payments work
with `BOOKING_ENABLED=false` and no NATS.

**Staging / Railway.** On the public service add `COMMERCE_API_URL` pointing at commerce's private
network address (for example `http://fionas-commerce.railway.internal:8080`) or its HTTPS URL, and
keep `ORIGIN` at the public HTTPS origin. Set commerce's `FIONAS_PUBLIC_BASE_URL` to that origin
(for example `https://dev.fionasicecream.com`). Exclude `X-Fionas-Payment-Token`, URL fragments,
staff payment-access responses and Checkout URLs from any proxy/CDN/APM logging, and don't cache
`/pay/*` or `/api/payments/*` at the edge. Allow at least 40 s upstream timeouts on
`/api/payments/*/checkout-sessions` (commerce may contact Stripe and recover an earlier attempt).
If commerce is down or Stripe disabled, `/pay` says so and the marketing site and `/book` are
unaffected.

## Test-mode acceptance (manual)

Follow commerce's operations runbook for Stripe test mode and the webhook listener, then:

1. Grant a staff role `fionas.payment-access.manage`; confirm another account without it still
   sees the workspace and manual payments but no Customer payments card.
2. On a QUOTED request, **Create payment link**, then **Copy payment link**; copy again and confirm
   the same URL.
3. Open it in a fresh window: the fragment disappears, Quote v{n} and the exact deposit show.
4. Pay the deposit with test card `4242 4242 4242 4242`; on return the page shows confirming,
   then **Deposit received. Your booking is confirmed.**, Booked, Invoice v{n} and the balance.
5. Amend the Invoice in the console; reload the same link: the new Invoice revision and balance.
6. Pay a partial amount, then the rest; the page reports each applied payment and the balance.
7. Start a checkout and press Back on Stripe: **Checkout was cancelled**; **Check previous payment
   and continue** returns to the same Session.
8. Rotate the link: the old copy shows "no longer active"; the new copy works. Revoke: both fail.
9. Inspect **Online payment attempts** for the attempts above; use **Check with Stripe** on an open
   one.
10. Close the request after settlement: the link shows read-only history; the card offers only
    copy and revoke.

## Tests

- Public unit: `money.test.ts`, `contract.test.ts` (summary/command/response readers and every
  view state), `controller.test.ts` (fragment capture, storage restore, missing/malformed/revoked
  links, exact deposit and Invoice bodies, duplicate clicks, same-key ambiguous retry and reload,
  terms changed, key reuse, unknown codes, Stripe returns, polling and visibility, recovery codes,
  expired replays), `bff.server.test.ts` (forwarded headers only, no cookies/SERVICE auth, token
  never in URLs, cross-origin/cross-site refusal, body and header validation, whitelisting,
  disabled/unreachable/misconfigured, no secrets in logs), `server-boundary.test.ts`.
- Public E2E (`npm run test:e2e:payments --workspace=@fionas/public`; part of `test:e2e`; no
  Docker or NATS), desktop and mobile, against `e2e/payments/stub-commerce.mjs` with
  `checkout.stripe.com` simulated by routed pages: fragment capture and cleanup, security headers,
  storage restore after Stripe, missing/incomplete/rotated/revoked links, exact deposit, full and
  partial Invoice payments with precision/minimum/maximum/balance validation, an amendment on the
  same URL, changed terms, confirmation only from the summary, cancelled-but-open resume, pending
  polling, new-browser recovery without loops, same-key ambiguous retry, rapid clicks, staff
  review, CLOSED history, disabled/unreachable backend, unknown codes, cross-origin refusal,
  keyboard use, no horizontal scroll and the no-JavaScript fallback.
- Admin unit: `customer-payments.test.ts`. Admin E2E: `customer-payments.e2e.ts` (permission
  gating, stable copy, rotate/revoke, CLOSED and REQUESTED/DECLINED limits, no URL in HTML,
  clipboard fallback, attempt diagnostics and reconcile feedback, live refresh with the composer
  draft preserved, disabled and ambiguous outcomes).

## Known limitations and future work

- The Checkout host allowlist is `checkout.stripe.com`; a Stripe custom Checkout domain would need
  adding to `checkoutRedirect`.
- Polling stops after about six minutes; the customer can **Check again**. There is no public push.
- If sessionStorage is lost after leaving for Stripe, the customer must reopen the original link
  (by design; there is no credential recovery).
- No receipts, Invoice PDFs, payment-link emails, refunds, disputes or automatic reconciliation of
  unapplied money in this milestone. Staff resolve unapplied receipts through existing ledger tools.
- Staff copying needs a secure context (HTTPS or localhost) for the clipboard; elsewhere the
  fallback field is used.
