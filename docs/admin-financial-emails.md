# Quote and Invoice emails

Staff manually email the **current published Quote** while an inquiry is QUOTED, and the **current
balance-due Invoice** while it is SERVED, in the booking's existing email conversation. Each email
carries the customer's stable payment link. This follows fionas-commerce PR #39
(`docs/financial-emails-frontend-handoff.md`, `FinancialEmailRoutes.kt`). Commerce renders the
email, resolves the recipient, validates the document, issues or reuses the payment link, owns
idempotency and talks to the Conversation Service. The admin owns only the staff workflow: it has no
email renderer, no Resend client and no financial authority.

Publishing, revising, amending, serving and recording payments never send email. There are no
automatic or scheduled emails, reminders, PDFs or template editor.

## Where code lives

| Concern                                   | File                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| Transport types                           | `apps/admin/src/lib/financial-email-contract.ts`                         |
| Target, message rules, validators, status | `apps/admin/src/lib/financial-email.ts`                                  |
| Isolated preview document                 | `apps/admin/src/lib/email-preview.ts`                                    |
| Commerce calls (preview, send)            | `apps/admin/src/lib/server/financial-email.ts`                           |
| Sealed exact-command recovery             | `apps/admin/src/lib/server/financial-email-recovery.ts`                  |
| Load and form actions                     | `apps/admin/src/lib/server/financial-email-actions.ts`                   |
| Right now status block                    | `$lib/components/requests/financial-email/financial-email-status.svelte` |
| Review panel and preview frame            | `$lib/components/requests/financial-email/`                              |
| Stub and journeys                         | `apps/admin/e2e/financial-email-stub.mjs`, `financial-email.e2e.ts`      |

## Permissions and availability

Preview and send each require **all five** of `fionas.inquiries.read`,
`commerce.financial-document.read`, `fionas.communications.read`, `fionas.communications.send` and
`fionas.payment-access.manage`. The admin offers the action only when the signed-in staff USER has
all five and still checks them in both actions before any backend call; commerce enforces them
again. No role receives them automatically, and no service identity is ever substituted.

The **Customer email** block in Right now appears only while QUOTED (Quote) or SERVED (Invoice),
or while this browser holds an unresolved send. It shows the status from commerce history even
without the permissions, and explains why emailing is unavailable:

- **SERVED, no positive balance** (fully paid) or **overpaid**: an explanation, never an action.
  Commerce decides collectibility; the admin's balance check only explains.
- **Missing business revision**: the commerce deployment predates the revision fields.
- **Conversation not reviewable** (timeline unavailable, MISSING, UNAVAILABLE, FORBIDDEN): no send.
- **An UNKNOWN command exists** (anyone's): nothing else can be emailed until it is reconciled.
- BOOKED, CLOSED, DECLINED and REQUESTED offer nothing.

`503 financial_email_tracking_not_verified` explains the operator prerequisite (below). Every other
documented refusal has its own copy (`financialEmailError`); backend messages and request contents
are never shown.

## Identities

`financialEmailTarget` reads the authoritative staff request only:

| Field                                | Source                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `documentId`                         | `financial.id` (canonical lineage)                                        |
| `expectedDocumentVersion`            | `financial.version` (ledger snapshot)                                     |
| `expectedBusinessRevision`           | `currentQuoteRevision` (QUOTE) or `currentInvoiceRevision` (INVOICE)      |
| `proposalId`                         | `proposal.id`, QUOTE only; must point at the current document version     |
| `expectedDepositRequirementRevision` | `proposal.depositRequirementRevision`, QUOTE only; must be the ACTIVE one |

`request-contract.ts` now carries `currentQuoteRevision`, `acceptedQuoteRevision`,
`currentInvoiceRevision` and `proposal.quoteRevision`. They are never inferred from the ledger
version or history length; if commerce omits them the email is unavailable.

## Workflow

**Email quote** / **Email invoice** opens `?email` (a native link; the panel keeps the Requests
return context through every action). The panel shows the authoritative recipient (the staff
detail's customer before preview, the preview's afterwards), the thread it will use (reply in the
existing thread, or start the booking thread), the staff-only document identity
("Quote v2 · revision 2") and an optional personal message.

1. **Preview email** posts the identity the page shows plus the conversation expectation the
   Activity column currently shows. The action re-reads the staff request and timeline and refuses
   a changed document, newer correspondence or any UNKNOWN command instead of rebasing. Previews are
   write-free in commerce and never call the preview endpoint while typing.
2. The review shows the subject, the backend's exact total, amount due now, paid, remaining balance
   and (Quote) balance after deposit, the HTML in an isolated frame (desktop/phone width toggle) and
   the plain-text alternative. The payment button is the inert `https://example.invalid/payment-preview`.
3. **Send quote** / **Send invoice** appears only while the review is still valid. Editing the
   message, a changed document (live re-read of the staff request), newer correspondence, an
   unreloadable details change or a changed review token withdraws it until **Preview again**.
4. The outcome is announced in the panel's status region and the Customer email block. Accepted
   means _accepted by the email provider_; delivery is shown only when provider state reports it.

Message rules match commerce's `FinancialEmailMessage`: CRLF/LF normalized to LF, trimmed at the
edges, at most 2,000 UTF-16 units, well-formed Unicode, no controls except tab/CR/LF; internal blank
lines (paragraphs) are kept; blank means the default greeting (the field is omitted).

The panel is distinct from the reply composer (a plain-text conversation reply), from publishing a
Quote (the editor) and from recording a payment, and its copy says so.

### Preview isolation

Backend HTML is display content and never reaches the admin DOM. `email-preview.ts` builds a
`srcdoc` for an `<iframe sandbox="">` (opaque origin: no scripts, forms, popups, plugins or top
navigation, `referrerpolicy="no-referrer"`). The document adds its own CSP
(`default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'`),
so remote images (the logo) and other resources are not fetched, strips `<meta http-equiv="refresh">`
and every `target` attribute, and injects `<base target="_blank">`, so every link would open a popup,
which the sandbox blocks. Workspace responses also send `Content-Security-Policy: frame-src 'none'`.
The plain-text alternative is rendered as escaped text.

## Exact-command recovery

The key, the complete email intent (including the message), the review token and the original
conversation expectation become the command **at preview time**, before any send can happen:

- The preview action mints a random key and seals the whole command with AES-256-GCM into
  HttpOnly, `SameSite=Strict`, `Secure` (on HTTPS) cookies named `fionas_fe0`…`fionas_fe2`, scoped to
  `/requests/{inquiryId}` and authenticated (AAD) to the staff user and inquiry. The browser cannot
  read or alter it; another user, inquiry or key cannot open it. An identical re-review keeps the key;
  any change mints a new one.
- Send and **Reconcile original send** always post that sealed command, never form values: the same
  key, email, message, review token and _original_ expectation, even after newer correspondence or
  the email itself appear in Activity. Any submission of one review (double click, native resubmit,
  retry after a lost response) therefore repeats one idempotent command.
- The record moves to `attempted` before the network call, then `unknown` on 202 UNKNOWN, timeouts,
  5xx, malformed successes or `IDEMPOTENCY_KEY_REUSED`; `rejected` on definitive pre-send refusals
  (stale review, ineligible, revoked access, conversation changed/missing, recipient mismatch or
  not allowed, validation, `email_send_rejected`); `reconciliation_required` stops. Configuration
  and availability refusals (`email_sending_disabled`, `email_provider_unavailable`,
  `stripe_disabled`, `financial_email_tracking_not_verified`, `financial_email_in_progress`,
  401/403/404) keep the command as it was. ACCEPTED (201, or a 200 replay) consumes the key: the
  enhanced path answers in place and refreshes Activity; the native path PRGs with a body-free
  one-time notice. A 200 replay says no new email was sent.
- A record whose response was lost still says `reviewed` in the browser. The load and the preview
  action then look for a commerce command by the same user, for the same identity, requested after
  the review: if one exists the review is locked to **Reconcile original send**. Commerce commits the
  intent before dispatching, so without such a record nothing under the key was sent.
- Locked states make the message read-only and offer only Reconcile; there is no Retry with a new
  key, no force-send and no "mark failed". A new timeline read never clears UNKNOWN. A definitive
  refusal allows a new deliberate review (new key).

**Fail closed.** If commerce reports an UNKNOWN command and this browser holds no matching record
(another browser or user, cleared cookies, a different `ADMIN_RECOVERY_SECRET`, more than 30 days),
the workspace says so, offers no preview or send and asks staff to escalate with the send ID.
Commerce also refuses new sends with `financial_email_in_progress` while any UNKNOWN exists.

**Limitations.** The record survives reloads, restarts and multiple admin instances only when every
instance shares `ADMIN_RECOVERY_SECRET` (at least 32 characters). Without it each process uses a
random key and records become unreadable after a restart (fail closed, with a startup warning). The
record lives in this browser profile for 30 days; it is not a draft store and unsent typing is not
kept. The message is stored encrypted in the cookie (at most three ~3.6 KB chunks); no payment URL,
bearer or rendered email is ever stored (previews are inert and sends return none). Recovery
cookies are never forwarded to commerce (`forwardedCookie` in `backend.ts`). The
lost-response heuristic compares timestamps with a two-minute allowance for clock skew; a false
match only turns Send into Reconcile, which still sends at most once under the key.

## Activity, SSE and status

The timeline's `financialEmails` (validated, including UNKNOWN and REJECTED) drive the Customer
email block: never emailed, current document emailed (commerce's `current`, never timestamps or the
ledger version alone), only an earlier revision emailed, UNKNOWN needing reconciliation (with send
IDs), and a rejected latest attempt. A MESSAGE with `financialEmail` metadata is labelled
**Quote emailed** / **Invoice emailed** with the staff-only `Quote v2 · revision 2`, Current/Earlier
and sender, plus the send ID under Message details; it is the same provider message, never a second
event. UNKNOWN and REJECTED commands without a message appear only in the status block.

The page keeps the latest applied Activity read, so status updates with live SSE refreshes and with
the targeted refresh after an enhanced send (`refreshSignal`). Financial-email commands are not part
of the `financialHistory` comparison (a send changes no staff request); payments, publications and
amendments still re-read the staff request, which invalidates an open preview. A send never
acknowledges correspondence, so Needs reply stays until staff mark it read. Drafts, the reply
composer and disclosures are untouched.

## Deployment prerequisites

- fionas-commerce PR #39 (migration V12), with `FIONAS_FINANCIAL_EMAIL_LINKS_UNTRACKED=false` until
  click tracking is disabled for the Resend sender domain (and any downstream rewriting) and a
  delivered test email's HTML **and** plain-text `/pay/{publicId}#secret` link are verified. Only
  then set it to `true`; until then the admin explains `financial_email_tracking_not_verified`.
- Existing conversation send settings, recipient allow-list and customer payment configuration.
- Grant the five permissions deliberately; none is granted automatically.
- Set the same `ADMIN_RECOVERY_SECRET` (32+ random characters) on every admin instance.
- Ingress timeouts of at least 110 s on the send route (as for replies).
- Before production: exercise both MIME alternatives in desktop and mobile mail, confirm the
  fragment survives without redirects, reply in the same thread, confirm staff full-text
  visibility and denial without `fionas.communications.read`, and open an old email after
  payment, amendment and revocation to confirm the payment page's authoritative state.
