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
| Right now status block (status only)      | `$lib/components/requests/financial-email/financial-email-status.svelte` |
| Right now action rows, post-send close    | `apps/admin/src/routes/(app)/requests/[inquiryId]/+page.svelte`          |
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

### Checkout independence

Since fionas-commerce PR #41, an active, processing or unresolved Stripe Checkout never makes the
current Quote or SERVED Invoice ineligible for email: commerce validates the document and ledger
terms independently of provider attempts, and the email uses neutral review wording ("Review your
quote", "Review your updated quote", "Review your invoice") that stays accurate whatever happens at
checkout. The admin matches that:

- `financialEmailTarget`, **Email quote** / **Email invoice**, preview and send read only the staff
  request, the timeline and permissions. Nothing here reads payment attempts or the public `canPay`;
  a successful commerce preview is the confirmation that this email is eligible.
- `financial_email_ineligible` copy names a changed stage or terms that can't be paid online, never
  a payment in progress; `financial_email_review_stale` and the panel's invalidation copy name the
  document, its recorded payments or the email.
- A Stripe check (including **Release previous checkout** under Customer payments) that answers
  EXPIRED, FAILED, OPEN, CREATING or PROCESSING changes nothing an email review binds, so it
  re-reads neither the staff request nor Activity and never invalidates an open preview. A captured
  or applied payment does re-read both, and a changed document, ledger payment, customer or message
  still invalidates the review here and at commerce (`financial_email_review_stale`).
- Sending an updated Quote never requires releasing the old checkout first, and releasing it never
  requires an email; the two are separate cards and actions. See
  [Previous checkouts after a revision](customer-payments.md#previous-checkouts-after-a-revision).

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

**Email quote** / **Email invoice** sits in Right now's secondary action row (see
[admin-request-workspace.md](admin-request-workspace.md)) and opens `?email` (a
native link; the panel keeps the Requests return context through every action). The panel shows the
authoritative recipient (the staff detail's customer before preview, the preview's afterwards), the
thread it will use (reply in the existing thread, or start the booking thread), what it is
**Sending** ("Quote v2", staff only) and an optional personal message.

### Staff wording

Copy lives in `financial-email.ts` (`emailCopy`, `unavailableCopy`, `financialEmailError`,
`missingEmailPermissionCopy`, `acceptedNoticeCopy`) so each sentence is one tested string. It names
the customer by first name (`customerFirstName`, "the customer" if blank) and times as
`receivedTimeLabel` + " Pacific" (`pacificTimeLabel`). It is plain on purpose: "We can't tell if
this email went out", **Check again** / "Checking…", "That send was refused, so nothing went out",
"Ask an administrator to turn on emailing for you…" (never the five permission names). The meaning
of every state is unchanged; only the words changed.

### One staff version label

The email panel labels its target with `expectedBusinessRevision`. The earlier-email status and
Activity details label each send with `businessRevision`. A service-only change can yield
Quote v2 and Quote v3 emails that both refer to financial snapshot v2. Commerce's `current` flag
determines **Current** and **Earlier**. Customers see versionless subjects and bodies.

1. **Preview email** posts the identity the page shows plus the conversation expectation the
   Activity column currently shows. The action re-reads the staff request and timeline and refuses
   a changed document, newer correspondence or any UNKNOWN command instead of rebasing. Previews are
   write-free in commerce and never call the preview endpoint while typing.
2. The review shows the subject, the backend's exact total, amount due now, paid, remaining balance
   and (Quote) balance after deposit, the HTML in an isolated frame and the plain-text alternative.
   The payment button is the inert `https://example.invalid/payment-preview`. The frame is 720px
   tall; **Show the whole email** / **Shorter preview** switches it to a fixed 1,800px with
   `scrolling="no"`. The opaque-origin sandbox can't be measured from the parent, so it is never
   loosened to auto-size. **Desktop** is full width; **Phone** shows 375px inside a handset
   outline (ink-700 surround, 12px padding and 18px at the bottom, 16px outer and 10px screen
   radius, a 64×5px ink-500 pill above the screen). The full-length and plain-text toggles are
   CSS-driven checkboxes styled as chips, so they also work without JavaScript.
3. **Send quote** / **Send invoice** appears only while the review is still valid. Editing the
   message, a changed document (live re-read of the staff request), newer correspondence, an
   unreloadable details change or a changed review token withdraws it until **Preview again**.
4. **Accepted (201) or replayed (200): the panel closes.** Enhanced, the page leaves `?email` with
   `replaceState` (no new history entry and no reload, so drafts, the reply composer and
   disclosures stay), refreshes Activity once, and moves focus to a status notice in the Customer
   email block: "Sent just now. **See it in Activity**; it shows as delivered once the email
   provider confirms." A replay reads "This Quote email already went out earlier, so nothing new
   was sent." The link targets the Activity message (`#message-{id}`, matched by send ID) once the
   refreshed timeline has it, else `#conversation`. Natively, the PRG drops `?email`, so the same
   one-time notice lands with the panel closed. Reopening after an enhanced send re-runs the load
   (`invalidateAll`), because shallow routing leaves SvelteKit's own URL at `?email`. Locked,
   refused and unknown outcomes keep the panel open, as before. Accepted means _accepted by the
   email provider_; delivery is shown only when provider state reports it.

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
- Send and **Check again** (the reconcile button) always post that sealed command, never form values: the same
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
  enhanced path answers in place, closes the panel and refreshes Activity; the native path PRGs
  (without `?email`) with a body-free one-time notice. A 200 replay says no new email was sent.
- A record whose response was lost still says `reviewed` in the browser. The load and the preview
  action then look for a commerce command by the same user, for the same identity, requested after
  the review: if one exists the review is locked to **Check again**. Commerce commits the
  intent before dispatching, so without such a record nothing under the key was sent.
- Locked states make the message read-only and offer only Check again; there is no Retry with a new
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
match only turns Send into Check again, which still sends at most once under the key.

## Activity, SSE and status

The timeline's `financialEmails` (validated, including UNKNOWN and REJECTED) drive the Customer
email block: never emailed, current document emailed (commerce's `current`, never timestamps or the
ledger version alone), only an earlier revision emailed, UNKNOWN needing reconciliation (with send
IDs), and a refused latest attempt, followed by the one-time notice after a send. A MESSAGE with `financialEmail` metadata is labelled
**Quote emailed** / **Invoice emailed** with the staff-only `Quote v2`, Current/Earlier
and sender, plus the send ID under Message details; it is the same provider message, never a second
event. UNKNOWN and REJECTED commands without a message appear only in the status block.

The page keeps the latest applied Activity read, so status updates with live SSE refreshes and with
the targeted refresh after an enhanced send (`refreshSignal`). Financial-email commands are not part
of the `financialHistory` comparison (a send changes no staff request); payments, publications and
amendments still re-read the staff request. The panel invalidates its preview when the reviewed
identity changed, and commerce refuses a send whose reviewed facts (ledger payments included)
changed with `financial_email_review_stale`. Checkout state is part of neither. A send never
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
