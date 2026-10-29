# Request conversation

The request workspace shows Conversation at every lifecycle stage, after financial and revision
history. Closed and declined bookings retain correspondence access; financial eligibility is unchanged.
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
native disclosures and Pacific timestamps. Null text explicitly means unavailable plain text.
Financial bands render the supplied historical snapshot, deposit revision, receipt classification,
allocations and refund unwind without recomputing money. A publication is not an email. User
attribution is You/Staff; service attribution is System.

READY, EMPTY, MISSING, UNAVAILABLE and FORBIDDEN remain distinct. Commerce milestones remain visible
when the backend returns them alongside unavailable email. READY with zero messages is distinct from
EMPTY but uses the same empty send expectation, as supported by the backend topic lookup. Missing
established conversations never offer replacement. Send acceptance/pending and delivery are separate
labels; failed, delayed, bounced, complained, suppressed and indeterminate states remain visible.

## Permissions and acknowledgement

Existing inquiry/financial read permissions govern the workspace. Email content additionally needs
`fionas.communications.read`; the composer requires that plus `fionas.communications.send` on the
signed-in staff USER. Mark as read requires `fionas.communications.acknowledge`. Backend authorization
is final. Roles are never used as permission proxies. Existing uncertainty blocks on financial or
decline actions also disable communication mutations until reviewed.

Needs reply is copied from commerce, never inferred from message direction, provider unread state,
delivery failure or local timestamps. The request list retains backend membership, order and counts.
The workspace submits exactly the displayed `throughRecordedOrder` to acknowledge, once. It never
fetches a newer watermark to make acknowledgement succeed. A 204 uses PRG; a stale conflict asks staff
to refresh and review. Other ambiguous failures require review. Acknowledgement changes only commerce
attention, not provider lifecycle or delivery.

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

Expired text is purged at least once per minute, and accepted text immediately. The pointer lasts
seven days so a missing record after expiry/restart fails closed instead of silently starting another
email. Do not treat this as durable draft storage. Unsubmitted typing stays only in the page; submitted
text can survive navigation/reload within the recovery window. No email body is written to localStorage,
sessionStorage, cookies, URLs, logs or a draft database.

**Operational limitation:** run one admin replica, or use sticky routing for the recovery window.
A process restart, expired record, cleared browser cookie, new browser or lost session can make the
original command unavailable. With a surviving pointer the composer blocks and tells staff to review
the timeline and contact an administrator. Without the original command, do not resend under a new
key while the old send may surface. Follow commerce's abandoned-UNKNOWN runbook. An administrator may
clear the inquiry-scoped `fionas_reply_intent` cookie only after resolving whether a prior send exists;
clearing it is not reconciliation. The same caution applies when an unused draft expires: the frontend
can no longer prove it was unused. A durable provider lookup by idempotency key is an upstream follow-up,
not something this frontend fabricates.

## Timeout and deployment

Only the reply transport accepts a validated `Idempotency-Key` (ASCII letters/digits/underscore/hyphen,
1–128 characters); it cannot override Cookie, Authorization, Origin or Host. Its timeout is 100 seconds.
The verified backend send timeout defaults to 10 seconds per provider request and is configurable up
to 30 seconds. A lookup plus two bounded send attempts can therefore take 90 seconds, before local
transaction overhead. Other commerce calls retain the existing eight-second timeout. Configure
admin/backend ingress and reverse proxies for **at least 110 seconds** on this route. A shorter proxy
timeout remains ambiguous and uses the same recovery flow; no timeout proves a send failed.

Deploy the commerce migrations/configuration and role grants from its email-conversations runbook.
Existing roles do not acquire read/send permissions automatically. Verify provider read/send flags,
recipient allowlist, trusted origins and optional inbound event intake before production use. This
frontend adds no automatic inquiry, Quote or Invoice emails and no provider configuration.

## Refresh and notifications

Refresh conversation is a native GET form. With JavaScript it fetches only the admin-origin
`/requests/{id}/conversation` no-store endpoint; no full-page invalidation resets other forms. Reads do
not overlap, and failed refreshes keep the previously displayed view with explicit stale-view copy.
Keyed message components keep disclosure choices and the composer retains its original intent.

There is no periodic polling: full timeline reads may fetch all provider history. New inbound IDs
observed by a successful manual refresh produce one persistent, dismissible notification naming the
booking and linking/focusing the new message. Historical messages on initial load do not notify.
This works only in the active workspace. Global notifications, cheap change signals, SSE, HTML,
attachments and automatic email delivery are intentionally absent. A trustworthy timeline head/ETag
and provider send-key lookup are small upstream improvements for later iterations.

## Tests

Contract/presentation, transport and action tests cover safe validation, statuses, exact commands,
timeouts, observed acknowledgement, scoped recovery, duplicate clicks, expiry and explicit review.
The session-isolated commerce stub models accepted/replayed/unknown replies, stale expectations,
concurrent inbound attention and acknowledgements without live email credentials. Playwright covers
desktop/mobile and native forms, return context, historical Quote expansion, escaped/null content,
permissions, refresh preservation, attention and uncertain reconciliation.
