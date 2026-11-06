# Request conversation

The request workspace shows Conversation, headed **Activity**, at every lifecycle stage as its main
column and single booking history: when the timeline loads, the workspace drops the cards that repeated
its bands (payments, quote publications, the decline decision); see
[admin-request-workspace.md](admin-request-workspace.md#integrated-conversation). Closed and declined bookings retain correspondence access; financial eligibility is unchanged.
The implementation follows fionas-commerce PR #32 at `9f2bc0244e8e310660a2dbc3de45c56fc3828a8b`
(still open when integrated), its route DTOs, generated OpenAPI and conversation tests. Deploy that
contract or its merged equivalent before enabling the feature. No provider credentials belong here.

## Ownership and reads

The browser calls only the admin origin. `server/conversation.ts` uses the established commerce
transport with the current staff cookie and trusted Origin. Commerce owns attention and the unified
timeline; the Resend Conversation Service owns email. Neither admin JavaScript nor admin server code
calls Resend or NATS.

The primary staff-request GET remains authoritative. A valid `communication` summary enables an
optional timeline read; a missing/invalid summary or missing route during deployment overlap shows
unavailable functionality without hiding the booking, payments, revision histories or fulfillment.
`conversation-contract.ts` isolates the new types. `conversation.ts` validates the optional read,
rejects malformed or duplicate item identities and refuses message content outside READY. Logs contain
only a fixed technical description, never returned content. The list accepts absent attention fields
during overlap and labels that state unavailable rather than treating it as false.

Items retain backend order and stable IDs. Messages use escaped plain text, preserved whitespace,
native disclosures and Pacific timestamps. `textVisibility` (fionas-commerce PR #39) is READABLE
(complete provider text, possibly empty, including financial emails, customer replies, staff
replies, payment links and quoted history) or PROVIDER_CONTENT_UNAVAILABLE (no text; shown as
unavailable, never as an empty customer message). Older commerce omits it, and null text then means
unavailable. `textOmittedForPaymentSecurity` is deprecated, always false and ignored; there are no
protected/unverified states. Text is always rendered escaped, never as HTML. Only staff with
`fionas.communications.read` receive provider content (others get FORBIDDEN, with commerce and
financial-email history still shown).
Quoted history a mail client appends below a reply (`On … wrote:` over `>` lines, two or more bare
`>` lines, or an Outlook header block) is folded behind a native Show quoted text disclosure by
`splitQuotedTrail`. It is display only, not a security filter: the text is never altered or removed
from the data model, inline replies and fully quoted messages stay whole, and the collapsed preview
uses the reply's own words. A customer email's
recipient is the per-conversation reply-routing address, an internal identifier, so its header
reads "To Fiona's Ice Cream"; staff replies show the customer address they went to. For debugging,
a collapsed Message details disclosure lists the exact From and To addresses and the message ID.
Financial bands render the supplied historical snapshot, deposit revision, receipt classification,
allocations and refund unwind without recomputing money. A publication is not an email. User
attribution is You/Staff; service attribution is System.

READY, EMPTY, MISSING, UNAVAILABLE and FORBIDDEN remain distinct. Commerce milestones remain visible
when the backend returns them alongside unavailable email. READY with zero messages is distinct from
EMPTY but uses the same empty send expectation, as supported by the backend topic lookup. Missing
established conversations never offer replacement. Send acceptance/pending and delivery are separate
labels; failed, delayed, bounced, complained, suppressed and indeterminate states remain visible.

## Financial emails in Activity

The timeline's `financialEmails` command history and an outbound MESSAGE's matching `financialEmail`
metadata are validated with the rest of the read (unique send IDs; metadata only on outbound
messages and only for that message ID). Such a message is labelled **Quote emailed** /
**Invoice emailed** with the staff-only document version and business revision, Current/Earlier
(commerce's `current`) and sender; it is the provider message itself, never an extra band. UNKNOWN
and REJECTED commands without a message appear in Right now's **Customer email** block. A financial
email never acknowledges correspondence: Needs reply and the watermark are unchanged, and the reply
composer, its key and expectation are untouched. Financial-email commands are excluded from the
`financialHistory` comparison (a send changes no staff request), while `onrefreshed` passes the
applied timeline so the workspace updates email status. After an enhanced send the workspace bumps
`refreshSignal` for one targeted Activity read instead of invalidating the page. See
[admin-financial-emails.md](admin-financial-emails.md).

## Permissions and acknowledgement

Existing inquiry/financial read permissions govern the workspace. Email content additionally needs
`fionas.communications.read`; the composer requires that plus `fionas.communications.send` on the
signed-in staff USER. Mark as read requires `fionas.communications.acknowledge` plus `fionas.communications.read`. Backend authorization
is final. Roles are never used as permission proxies. Existing uncertainty blocks on financial or
decline actions also disable communication mutations until reviewed.

Needs reply is copied from commerce, never inferred from message direction, provider unread state,
delivery failure or local timestamps. The request list retains backend membership, order and counts.
The workspace submits exactly the displayed `throughRecordedOrder` to acknowledge, once. It never
fetches a newer watermark to make acknowledgement succeed. A 204 uses PRG; a stale conflict asks staff
to refresh and review. Other ambiguous failures require review. Acknowledgement changes only commerce
attention, not provider lifecycle or delivery.

Attention can only be cleared by someone who can see what it is about. Needs reply stays visible in
every state, but Mark as read appears only while the conversation is READY and the user holds
`fionas.communications.read`. Otherwise the strip explains that it becomes available once the messages
can be reviewed. The action enforces the same rule for native and crafted posts: it requires the read
permission, then makes one availability read and refuses unless that read is READY (provider outage,
FORBIDDEN, MISSING, EMPTY or a failed read). That read only gates availability; its watermark is never
posted. The observed watermark is.

Mark as read never discards an unsent reply. While the composer form exists, the button belongs to
it (`form`, `formaction`, `formnovalidate`, with the watermark as the button's own name/value), so a
native or enhanced post carries the composer's key and text. For a never-attempted draft the action
stores that text in the draft's existing in-memory record before acknowledging, and the PRG restores
it. Locked (uncertain) replies are never rewritten. Without a composer, a standalone form is used.

## Reply identity and recovery

Both native and enhanced forms use `sendConversationReply`. The recipient and signature come from
commerce; the frontend sends only normalized plain text and the original expectation. Body validation
matches the backend's 1–5,000 UTF-16 character limit, trimming edges and refusing control characters
other than tab/newline/carriage return. Normal Enter inserts a newline; Ctrl/Cmd+Enter submits.

`server/reply-intents.ts` keeps bounded, process-local recovery records (maximum 1,000, two-hour TTL).
A cryptographically random per-draft key is created on the reviewed page. An HttpOnly, SameSite=Strict,
inquiry-path cookie holds only its opaque pointer, never message text. Records are bound to the staff
user and inquiry. On first submission the normalized body, key and original expectation become
immutable before the network call. The server rejects changed content and overlapping submissions.
Explicit reconciliation repeats exactly that stored command; neither refresh nor new inbound mail
rebases it. No transport retry occurs.

HTTP 200/201 with a validated ACCEPTED response clears the submitted body and redirects to the
authoritative GET, preserving Requests return context. It never appends a fabricated message or
claims delivery. HTTP 202 UNKNOWN, network timeouts, malformed successes and unexpected errors retain
the intent and lock the text. Staff can refresh/read the timeline and explicitly reconcile. A known
definitive rejection/stale conflict retains the draft; staff must review the visible conversation,
explicitly prepare a new intent, edit, then separately submit. UNKNOWN cannot use that path.

Native forms encode newlines as CRLF and enhanced ones as LF; the server normalizes both to LF, so one
message always has one body and one fingerprint.

Expired text is purged at least once per minute, and accepted text immediately. An expired record
leaves a body-free retirement marker (user, inquiry, expectation and final state) that outlives the
seven-day pointer cookie, so every pointer this process issued stays classifiable:

- **Never attempted, definitively refused or accepted:** no send under that key is unresolved. Loading
  quietly mints a fresh draft. A submission from the expired form keeps its text in a fresh draft with
  the same observed expectation, sends nothing, and asks staff to review and submit again. The copy
  never says "nothing was sent" for an accepted key.
- **Attempted with an unknown outcome:** fails closed (recoveryLost). No fresh key is issued because a
  record went missing.
- **Unknown to this process** (restart, another replica, tampered cookie): fails closed.

Do not treat this as durable draft storage. Unsubmitted typing stays only in the page, except text
carried by Mark as read, which lives only in that draft's two-hour record. Submitted text can survive
navigation/reload within the recovery window. No email body is written to localStorage, sessionStorage,
cookies, URLs, logs or a draft database. Both stores are bounded (1,000 records, 20,000 markers); a full
store shows no composer rather than an unclassifiable pointer.

**Operational limitation:** run one admin replica, or use sticky routing for the recovery window.
A process restart, an expired attempted record, a cleared browser cookie, a new browser or a lost
session can make the original command unavailable. Expiry alone no longer blocks untouched drafts.
**Restart tradeoff:** markers are process memory, so after a restart or deploy the server cannot tell
whether a pre-restart pointer was ever submitted. Any browser that viewed a workspace before the restart
therefore sees the blocked state on that inquiry, even for a draft it never sent. This is deliberate:
classifying it as safe would risk a duplicate email whenever an attempt's response was lost. Prefer
deploying when no replies are being composed, and resolve blocked inquiries as below. With a surviving pointer the composer blocks and tells staff to review
the timeline and contact an administrator. Without the original command, do not resend under a new
key while the old send may surface. Follow commerce's abandoned-UNKNOWN runbook. An administrator may
clear the inquiry-scoped `fionas_reply_intent` cookie only after resolving whether a prior send exists;
clearing it is not reconciliation. The same caution applies when an unused draft expires: the frontend
can no longer prove it was unused. A durable provider lookup by idempotency key is an upstream follow-up,
not something this frontend fabricates.

## Timeout and deployment

Only the reply and financial-email send transports accept a validated `Idempotency-Key` (ASCII
letters/digits/underscore/hyphen, 1–128 characters), each bound to its own route; it cannot override
Cookie, Authorization, Origin or Host. Their timeout is 100 seconds.
The verified backend send timeout defaults to 10 seconds per provider request and is configurable up
to 30 seconds. A lookup plus two bounded send attempts can therefore take 90 seconds, before local
transaction overhead. Other commerce calls retain the existing eight-second timeout. Configure
admin/backend ingress and reverse proxies for **at least 110 seconds** on this route. A shorter proxy
timeout remains ambiguous and uses the same recovery flow; no timeout proves a send failed.

Deploy the commerce migrations/configuration and role grants from its email-conversations runbook.
Existing roles do not acquire read/send permissions automatically. Verify provider read/send flags,
recipient allowlist, trusted origins and optional inbound event intake before production use. This
frontend adds no automatic inquiry, Quote or Invoice emails and no provider configuration; Quote
and Invoice emails are staff-initiated only ([admin-financial-emails.md](admin-financial-emails.md)).

## Refresh and notifications

Refresh (the Activity header's button) is a native GET form. With JavaScript it fetches only the admin-origin
`/requests/{id}/conversation` no-store endpoint; no full-page invalidation resets other forms. Reads do
not overlap, and failed refreshes keep the previously displayed view with explicit stale-view copy.
Keyed message components keep disclosure choices and the composer retains its original intent.

There is no periodic polling: full timeline reads may fetch all provider history. New inbound IDs
observed by a successful manual or live refresh produce one persistent, dismissible notification naming the
booking and linking/focusing the new message. Historical messages on initial load do not notify.
This works only in the active workspace. Global notifications, HTML,
attachments and automatic email delivery are intentionally absent. A trustworthy timeline head/ETag
and provider send-key lookup are small upstream improvements for later iterations.

## Tests

Contract/presentation, transport and action tests cover safe validation, statuses, exact commands,
timeouts, observed acknowledgement, the reviewable-messages gate, draft retention across Mark as read,
scoped recovery, duplicate clicks, expired-draft versus attempted-send classification and explicit review.
The session-isolated commerce stub models accepted/replayed/unknown replies, stale expectations,
concurrent inbound attention and acknowledgements without live email credentials. Playwright covers
desktop/mobile and native forms, return context, historical Quote expansion, escaped/null content,
permissions, refresh preservation, attention and uncertain reconciliation. Enhanced and native runs
cover Mark as read being withheld under FORBIDDEN, UNAVAILABLE and provider outage, refusal of an
outage that starts after loading, refusal of crafted posts, draft survival across Mark as read, and
fail-closed handling of a pointer the server never issued. Two-hour expiry is covered by unit tests.

## Live timeline updates

Native EventSource connects to `/requests/{inquiryId}/updates` on the admin origin. The server-only
`timeline-updates.ts` transport forwards the staff Cookie, trusted `backendConfig` Origin and SSE
Accept to commerce `/staff/requests/{inquiryId}/updates`. No SERVICE token, browser-selected headers
or Last-Event-ID are forwarded. The exact GET route bypasses the hook's `/auth/me` lookup and login
redirect; the actual commerce handshake authenticates and authorizes every subscription. Missing
cookies and malformed UUIDs terminate locally; commerce remains the permission authority. Other
page/form authentication is unchanged.

A successful response streams bytes unchanged, with an initial BFF retry directive to cover admission
ending before commerce sends its own. Framing, IDs, comments and ordering are preserved. Headers are
`text/event-stream; charset=utf-8`, `Cache-Control: no-store, no-transform`, and
`X-Accel-Buffering: no`. Only the handshake/error classification has an eight-second deadline; the
body has no whole-response timeout. Downstream cancellation aborts commerce. EOF or body failure
ends cleanly, allowing native reconnection without invented events or diagnostics.

Temporary network failures/timeouts and temporary 503s produce a short 200 SSE retry placeholder,
with a uniformly jittered 5–7 second retry. It contains no event and never refreshes history. A 503
is retryable even with an empty, HTML, plain-text, malformed or oversized diagnostic body. Only a
complete JSON error with code `timeline_updates_unavailable` identifies a disabled subscription.
That disabled 503, 400/401/403/404, redirects, missing or malformed successful streams and
unclassified statuses terminate with 204. 500/502 are terminal because the current contract provides
no reliable transient classifier for them. Error-body classification is bounded to 8 KiB; private
error content never reaches the browser. Healthy commerce streams replace the initial retry floor
with their 3000ms directive. Their normal ~60-second termination is expected.

One per-card controller connects only with inquiry, financial-document and communications read
permissions; send/acknowledge permissions are not required. It closes on destruction, hidden pages
and offline transitions, resuming on visible/online transitions unless the browser reported CLOSED
(terminal). Native EventSource owns retries. Two minutes without successful synchronization pauses
the source; manual Refresh or a visible/online transition can resume that budget.
Terminal subscriptions require a fresh page lifecycle after the underlying issue is resolved.
There is no polling or global connection manager.

Only validated `timeline.changed` data for this inquiry triggers the existing no-store conversation
read. Revisions are opaque decimal strings, including zero; a repeated revision on a new connection
still refreshes. Open, comments and placeholders do nothing. Live means a real notification followed
by a successful authoritative read, not transport-open. The quiet status has no live region to avoid
announcing routine reconnects. Previously displayed history remains available during failures.

Manual and automatic hints share one serialized refresh loop: bursts coalesce, but a hint during a
read schedules another read. Reads have a 15-second browser timeout, validate the entire timeline,
and apply atomically. Disposal aborts reads and suppresses late results. Automatic failures cause no
focus change, repeated toast or self-retry; a later hint/manual read can recover. Message IDs, not
revisions, govern the existing persistent inbound-email toast. Initial hydration does not notify.

The composer remains mounted; its draft, immutable original expectation/key and UNKNOWN recovery
are untouched. Live updates never send, reconcile or acknowledge. Keyed native disclosures retain
open state. The initial timeline supplies the financial and lifecycle history baseline. If it was
unavailable, the first validated refresh establishes the baseline without raising a warning.
Subsequent changes to authoritative non-communication history are reported to the workspace
(`onrefreshed({ historyChanged })`), which re-reads the staff request and updates Right now, the
Event card and the Serving plan in place; see
[Live staff financial state](admin-request-workspace.md#live-staff-financial-state). Only when that
is impossible (an open review panel, a failed or incoherent read) does Right now show **Request
details changed … Reload to review**, an explicit full reload for which staff preserve unfinished
work first. A card rendered without that handler keeps its own notice. No automatic page
invalidation replaces financial reviews, editors or mutation tokens. Timeline history alone cannot detect changes that commerce does not
represent there (for example a service-only amendment); existing expected-version protections remain.

### Deployment prerequisite and verification

Deploy fionas-commerce PR #34, commerce-runtime 0.0.27, V7/V8 migrations and the backend's bounded
PostgreSQL pool/transaction configuration first. Set **FIONAS_TIMELINE_UPDATES_ENABLED=true on commerce**;
it defaults false. No new admin environment variable is needed. Complete mixed-version rollout and
reconnect before relying on financial notifications. Provider changes depend on working commerce
intake; direct ledger writes outside Fiona operations are not covered. Retain manual refresh.

The installed adapter-node uses incremental Node response writes, backpressure and reader cancellation;
it does not dynamically compress this endpoint. Local real-stream browser tests cover flushing and
navigation cleanup. Production ingress has **not** been validated here. For every deployed hop verify:

- Disable SSE buffering, compression, caching and response transformations; retain the response headers.
- Permit long-lived responses and promptly flush delayed frames, with idle timeouts above the ~20s
  heartbeat (at least 30s; a 90s+ response allowance accommodates the normal 60s stream).
- Disconnect a browser and verify upstream subscriber release; keep ordinary requests responsive
  while streams are open. Capacity is 256 per instance / 16 per inquiry.
- Confirm native reconnection across the normal lifetime, transient outages and deployment; confirm
  disabled/forbidden streams stop. Follow commerce's at-least-100s shutdown grace guidance.

Backend reference: https://github.com/castab/fionas-commerce/blob/main/docs/staff-timeline-updates.md.
Retry rationale and Chromium evidence: https://github.com/castab/fionas-ui/pull/238.
