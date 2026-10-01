# Public inquiry submission

How a customer's `/book` request reaches `fionas-commerce`, and what the public SvelteKit app
promises along the way. Read this before changing the inquiry form, its action or the commerce
adapter.

**The invariant.** Every inquiry is a request for configured ice cream service. There is no
plain/contact-only inquiry (definition version 7):

```
No configured ice cream service   →  no inquiry submission
Complete configured service       →  POST /inquiries
                                  →  backend validates and prices it, authoritatively, once
                                  →  Inquiry + Estimate v1 (+ INITIAL_ESTIMATE) commit together
                                  →  customer sees "Request received"
```

## Trust boundary

```
 Browser                        Public SvelteKit server                     fionas-commerce
 ───────                        ───────────────────────                     ───────────────
 GET /book  ─────────────────▶  load: getInquiryForm() ─────────────────▶  GET /inquiry-form
 ◀── form + submissionToken                                                 (Bearer UI key)
 POST /book/estimate (JSON) ──▶  previewEstimate()  ────────────────────▶  POST /estimate-preview
 POST /book (form action) ────▶  submitInquiry() → createInquiry() ─────▶  POST /inquiries
   submissionToken,                                Authorization: Bearer <FIONAS_UI_API_KEY>
   catalogRevision, answers                        Idempotency-Key: <submissionToken>
 ◀── 303 /book/received  (or the form again, with a recoverable state)
```

- **The bearer credential is server-only.** `FIONAS_UI_API_KEY` (the backend's own name for the same
  shared key) is read through `$env/dynamic/private` in exactly one file,
  `apps/public/src/lib/server/commerce.ts`, at request time, so its value is never inlined into any
  build output. SvelteKit refuses to bundle `$lib/server` or private env into client code, and
  `src/server-boundary.test.ts` fails if any client-reachable source (routes, components,
  `@fionas/ui`, `@fionas/shared`) imports them. The key is never logged, returned in page data or
  echoed in errors; the e2e suite checks `/book`, `__data.json` and every file in `build/client`.
- **The browser only talks to the SvelteKit origin.** The backend sends no CORS headers and none
  are needed; CORS is not the security mechanism. The browser never learns the backend's address
  (`COMMERCE_API_URL`, shared with the admin app).
- **Page data is safe to show.** The browser receives the inquiry form definition (the backend's
  public form), a submission token, and, after a failed submit, its own answers and a customer-facing
  message. Backend diagnostic messages are never rendered or parsed.
- **Credentials stay simple.** One manually provisioned, rotatable key in deployment env. No OAuth,
  service principals or token exchange.

| Variable            | Where           | Purpose                                                              |
| ------------------- | --------------- | -------------------------------------------------------------------- |
| `COMMERCE_API_URL`  | private, server | fionas-commerce base URL (default `http://localhost:8080`)           |
| `FIONAS_UI_API_KEY` | private, server | trusted UI Bearer key; same value as the backend's variable          |
| `BOOKING_ENABLED`   | private, server | `true` serves `/book`; otherwise it 404s and CTAs show "coming soon" |

## Code map

| Concern                                                  | File                                                   |
| -------------------------------------------------------- | ------------------------------------------------------ |
| HTTP to fionas-commerce (URL, key, timeout, error kinds) | `apps/public/src/lib/server/commerce.ts`               |
| Response shape checks (fail closed)                      | `apps/public/src/lib/server/commerce-shapes.ts`        |
| Submission flow (token, revision, outcomes, receipt)     | `apps/public/src/lib/server/inquiry-submission.ts`     |
| Failure payload type + customer copy (client-safe)       | `apps/public/src/lib/inquiry-submission.ts`            |
| Form load + action                                       | `apps/public/src/routes/book/+page.server.ts`          |
| Estimate preview proxy                                   | `apps/public/src/routes/book/estimate/+server.ts`      |
| Form UI: sections, hidden token/revision, review, errors | `apps/public/src/routes/book/+page.svelte`             |
| One question: controls, offering chips, availability     | `apps/public/src/lib/components/inquiry-field.svelte`  |
| Estimate card                                            | `apps/public/src/lib/components/estimate-panel.svelte` |
| Confirmation page                                        | `apps/public/src/routes/book/received/`                |
| Submit gate, answer mapping, validation, reconciliation  | `packages/shared/src/inquiry.ts`                       |
| Advisory estimate arithmetic                             | `packages/shared/src/estimate.ts`                      |

## The adapter

`commerce.ts` owns the base URL, the Bearer header, request construction, JSON decoding, an 8 s
timeout and error decoding. Route files never call `fetch` on the backend. Operations:
`getInquiryForm({ fresh })`, `previewEstimate(pricingInputs)` and
`createInquiry(request, idempotencyKey)`. Every result is `{ ok: true, data }` or
`{ ok: false, error }`, where `error` keeps the backend's stable `code` and violation codes and adds
a `kind`:

| `kind`         | Meaning                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `validation`   | `400` / `422`: refused; nothing written                                                            |
| `not_found`    | `404`: catalog not initialized or unknown revision                                                 |
| `conflict`     | `409`: `CATALOG_REVISION_STALE`, `IDEMPOTENCY_KEY_REUSED`, `conflict`                              |
| `unauthorized` | `401` / `403`: our key was refused (logged for the operator)                                       |
| `server`       | `5xx`                                                                                              |
| `timeout`      | no answer within 8 s; for a POST the outcome is **unknown**                                        |
| `network`      | connection failed; for a POST the outcome is **unknown**                                           |
| `unexpected`   | outside the contract: unreadable or wrongly shaped body, odd status (redirects are never followed) |

A `2xx` is trusted only in its documented shape (`commerce-shapes.ts`): a form with an input type
this UI can't render, or a receipt or estimate without its fields, fails closed and `/book` shows
"isn't available right now" instead of guessing.

## The form comes from the backend

`GET /inquiry-form` (definition version 7, `EXPECTED_DEFINITION_VERSION`) is the source of truth for
which questions and options exist. `/book` renders its sections and fields in the order sent, with
the backend's titles, labels and descriptions, choosing controls from `input` semantics (`TEXT`,
`EMAIL`, `INTEGER`, `BOOLEAN`, `INTEGER_CHOICE`, `STRING_CHOICE`, `OFFERING_CHOICE`, `DATE`) and the
`presentation.control` hint, and maps answers back through each field's `submissionPointer`. No
offering keys, names, prices, category limits or durations live in UI code
(`src/catalog-hardcoding.test.ts` checks this against the captured form). There is no phone field:
the form doesn't ask for one. A different `definitionVersion` is logged once on the server; the
self-describing form still renders.

**Service configuration is mandatory.** The section `optional` flag means "may be omitted entirely";
in version 7 only "Additional information" is optional, and it alone shows an "Optional" badge. A
section that carries pricing questions (pointers under `/pricingInputs/`) is never skippable
(`isSkippable`), even if a future form marked it optional: `POST /inquiries` requires
`pricingInputs`, and the server logs the drift. A form that can't produce `pricingInputs` at all (no
guest-count or duration question, or a pricing pointer this UI doesn't understand:
`pricingContractProblem`) offers no form and accepts no submission.

**The submit gate.** `prepareInquiry(form, answers)` in `@fionas/shared` is the only way to build a
`POST /inquiries` body, used by both the browser (before posting) and the form action (before
sending). It validates every question that applies, then maps answers by pointer and checks the
transport floor again: a catalog revision, a whole-number guest count, a duration, and a selection
block meeting every category's minimum. It returns `invalid` (field errors) or `unpriceable` (the form
itself can't produce pricing) instead of a request, so there is no state equivalent to
`pricingInputs: undefined`.

**Offering availability.** Every option carries `selectionState` and `availability`:

| Backend state                   | Public form | UI                                                                                                               |
| ------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `ENABLED` + `AVAILABLE`         | listed      | normal chip, selectable                                                                                          |
| `ENABLED` + `UNAVAILABLE`       | listed      | visible and readable (dashed, muted), native `disabled`, "Unavailable — check back later" in its accessible name |
| `DISABLED` (either), or retired | **absent**  | nothing to show; absence is never presented as "temporarily unavailable"                                         |

Unavailable is temporary: the copy never says sold out, removed or disabled, and label, description,
price and position are kept. An unavailable option contributes nothing to the advisory estimate, and
local validation names it if it somehow ends up in the answers ("Horchata is unavailable right now —
please choose another."). A chip already checked from older answers stays enabled so it can be
unchecked. The backend still enforces this (`422 OFFERING_UNAVAILABLE` / `OFFERING_DISABLED`); the
UI only prevents the obvious mistake.

`minSelections`/`maxSelections` drive the "2 picked · choose 1–2" note, disable further chips at the
maximum, and feed local validation ("Choose at least 4."). When fewer options are selectable than
the minimum, the hint says the request can't be completed online today and to check back or email.

## Advisory estimate

The estimate card ("Your estimate so far", "Estimate only") is presentation. As soon as guest count
and duration are valid it computes instantly in the browser from `pricingPreview`: the duration's
`baseServiceAmount` once, `perGuestAmount` × guests, each selected option's price (`FIXED` once,
`PER_QUANTITY` × guests, `PER_DURATION` from the duration's `offeringContributions`) and the
`toppingAdjustment` per extra pick beyond `includedSelections`. Amounts are exact decimal strings,
summed as scaled `BigInt`s, never floats. No pricing rule lives in a frontend constant.

Once the whole service is configured, the card asks `POST /estimate-preview` (through
`/book/estimate`, debounced, once per distinct configuration) and shows the backend's figures. The
proxy forwards only the pricing facts, rebuilt field by field. A preview writes and reserves nothing.

**Backend pricing is authoritative.** `POST /inquiries` validates the current catalog, prices once
and atomically creates the Inquiry and Estimate v1. The browser never submits totals, line amounts or
estimate identity, and never compares its figures with the backend's.

## One token per logical submission

`Idempotency-Key` names one visible submission, not one HTTP attempt.

1. `load` mints a UUID (`newSubmissionToken`) for the rendered form. The page is `private, no-store`
   so no cache can hand one visitor's token to another.
2. The form posts it back in the hidden `submissionToken` field, with the hidden `catalogRevision`
   the answers were given against.
3. The action sends it unchanged as `Idempotency-Key`. Nothing on the server ever generates a key
   for an attempt.

So a double click, a duplicated delivery, a no-JS "resend form data?" reload, the adapter's own
retry and the customer pressing Send again after an outage all carry the same key, and the backend
turns them into one inquiry and the same `201` receipt. The token is not authentication; a browser
can change it, and the backend treats it purely as command identity (`[A-Za-z0-9_-]{1,128}`, checked
before sending so an empty token is refused locally).

A token changes only when the customer starts a new logical submission:

| Event                                               | Token                                          |
| --------------------------------------------------- | ---------------------------------------------- |
| Page view                                           | new                                            |
| Local or backend validation failure (`422`)         | kept (failures don't consume keys)             |
| Outcome unknown (timeout, lost response, 502–504)   | kept; answers frozen until it resolves         |
| ...then the customer chooses "Change my answers"    | new (a deliberate new submission)              |
| Nothing sent (backend unreachable), `5xx`           | kept                                           |
| `CATALOG_REVISION_STALE` → refreshed form to review | new (the reviewed form is a new submission)    |
| `422` naming unknown/disabled/unavailable offerings | new, with a refreshed form to review           |
| `IDEMPOTENCY_KEY_REUSED`                            | kept; "Send as a new request" uses a new one   |
| Success                                             | redirect to `/book/received`; form is finished |

## What is sent

`POST /inquiries` carries the customer's intent only: `name`, `email`, optional `message`, `zipCode`,
`eventDate`, `eventType` and, always, `pricingInputs` (`catalogRevision`, `guestCount`,
`guestCountIsMinimum` — false unless the form asks —, `durationMinutes`, `selections`: one
`{ category, offerings }` block per category with picks, in form order). Fields map through each
form field's `submissionPointer`. No totals, prices, lines, document or customer ids are sent.

`catalogRevision` is the one the customer saw (from the hidden field), never silently swapped for
the current one. When it still matches the current form the action runs the full gate. When the
catalog has moved on it still requires the complete service configuration but leaves option
membership to the backend, which either replays an earlier commit of this key or answers
`CATALOG_REVISION_STALE`.

## Outcomes

The action reports one `SubmissionFailure.outcome` per case (`apps/public/src/lib/inquiry-submission.ts`):

| Situation                                                                                    | `outcome`      | Customer sees                                                          | Key  |
| -------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------- | ---- |
| `201` (new or replayed — same receipt)                                                       | — (303)        | `/book/received`: "Request received", reference + time, not a booking  | done |
| answers fail the gate (including unconfigured service)                                       | `invalid`      | inline field errors; nothing sent                                      | kept |
| no usable token or revision posted                                                           | `malformed`    | "This page is out of date"                                             | —    |
| `409 CATALOG_REVISION_STALE`                                                                 | `stale`        | refreshed form + "Our menu changed" review notice                      | new  |
| `422` with a catalog-state violation (below)                                                 | `rejected`     | refreshed form + "Some of your choices need another look"              | new  |
| other `422`, `400`, `404`                                                                    | `rejected`     | form error from stable violation codes (`describeViolation`)           | kept |
| `409 IDEMPOTENCY_KEY_REUSED`                                                                 | `key_reused`   | "We couldn't safely verify this submission…" + "Send as a new request" | kept |
| form unreadable or unpriceable before sending; `401`/`403`                                   | `unavailable`  | "hasn't been sent"; edit freely, send again                            | kept |
| timeout, network failure, garbled `2xx`, `502`–`504`, `conflict` (after the adapter's retry) | `ambiguous`    | frozen answers, "Try sending again", optional "Change my answers"      | kept |
| `500` or another unexpected status                                                           | `server_error` | "Something went wrong on our side"; send again                         | kept |

Catalog-state violations (`CATALOG_STATE_VIOLATIONS`): `UNKNOWN_OFFERING`, `OFFERING_DISABLED`,
`OFFERING_UNAVAILABLE`, `PUBLIC_INQUIRY_CATEGORY_NOT_ALLOWED`. An honest current page can't produce
them (changing an offering's state advances the revision, so a stale page gets `CATALOG_REVISION_STALE`
first); if one arrives anyway the page was inconsistent or tampered with, so the action does the same
cache-bypassing refresh and review as for a stale catalog, and never resubmits. Behaviour keys off
codes only; backend messages are diagnostic and never parsed or shown.

**Success.** The receipt (`id`, `createdAt`) goes into a short-lived `HttpOnly` cookie and the action
redirects (`303`) to `/book/received` (post/redirect/get), so reloading or navigating never re-posts.
A replayed `201` is indistinguishable and treated the same. The page says "Request received": Fiona's
team will review and follow up; the date is not reserved and nothing is charged. It never says
booked, confirmed or reserved. The app never reads staff-only `/inquiries/{id}` and never sees or
shows Estimate ids.

**Stale catalog.** The action never resubmits. It re-reads `GET /inquiry-form` with
`cache: 'no-store'` and `Cache-Control: no-cache`, fits the answers to it with `reconcileAnswers`
and returns the new form, the reconciled answers, the labels of questions to look at again, the
names of unselected unavailable choices, how many choices left the menu, and a new token:

- name, email, ZIP, event date, message and guest count carry over; event type and duration carry
  over if the new form still offers them
- an offering that is now absent (disabled or retired) is dropped and counted; the notice says it
  "isn't on our menu anymore" and nothing more, since the public form says nothing more about it
- an offering that is now `UNAVAILABLE` stays listed but is unselected and unselectable, and the
  notice names it ("Horchata is unavailable right now — check back later. We've unselected it…")
- nothing is ever substituted. A raised minimum is never filled in and a lowered maximum is never
  trimmed: the question is flagged for review and the gate blocks sending until the customer fixes it
- the notice says prices may have changed; the estimate is recomputed from the new `pricingPreview`

The customer must press Send again; that is a new logical submission under the new token.

**Reused key.** Not retried automatically: a new key after an uncertain earlier submission could
create a duplicate inquiry. The server logs `[inquiry] Idempotency-Key … was already used` (the key
is not secret; no customer payload is logged) and offers a `restartToken`; the customer's explicit
"Send as a new request" submits the current answers under it.

## Retries and network ambiguity

A failed or timed-out request does not prove the backend failed: it may have committed before the
response was lost. Nothing infers from a timeout whether the inquiry exists. `createInquiry`
therefore retries **once**, after 250 ms, **with the same key and the same body**, when the outcome
is unknown or transient: a timeout or network failure, a `2xx` body that could not be read,
`502`/`503`/`504`, or the backend's documented retryable `409 conflict` (concurrent customer
creation). It never retries `400`, `404`, `422`, `CATALOG_REVISION_STALE`, `IDEMPOTENCY_KEY_REUSED`
or `500`. If the retry fails too, the action reports `ambiguous` with the same token.

The page then **freezes the answers**: the field area is `inert` (server-rendered, so this also
holds without JavaScript; inert controls still submit), the primary button becomes "Try sending
again", and the form posts `outcomeUnknown=true`. That retry is the same request under the same key,
so if the first one committed the backend replays its receipt. While unresolved, a retry that can't
get through (backend unreachable, `5xx`) stays `ambiguous` rather than unfreezing. Only a definite
answer ends it: a receipt, a stale/validation refusal (which commits nothing) or a reused-key
conflict.

If the customer would rather change their answers, "Change my answers" (JavaScript only) unfreezes
the form and swaps in the server-minted `restartToken`, with a note that the changes go as a new
request. That is the one way an ambiguous submission's answers can change, and it is explicit.

**Double clicks.** The submit button is disabled and the enhance handler ignores submits while one is
in flight, purely for UX. Correctness doesn't depend on it: any duplicate delivery (a double click
without JavaScript, a browser resend) carries the same key and gets the same receipt.

## Form caching

The backend marks the form `Cache-Control: private, max-age=60, must-revalidate`. The SvelteKit
server keeps no cache of it: every page view and every submit reads it from the backend (Node's
`fetch` has no HTTP cache). Stale recovery additionally sends `Cache-Control: no-cache` with
`cache: 'no-store'`, so a proxy between the app and the backend can't return the old form either.

## Tests

- `packages/shared/src/inquiry.test.ts`: the submit gate, including the critical regression that no
  contact-only or partial request can be built (also when a form marks the service optional, and for
  a form that can't produce pricing), section skippability, pointer mapping, reconciliation
  (unavailable, removed, raised minimum, lowered maximum).
- `packages/shared/src/estimate.test.ts`: every price form against synthetic prices, unavailable
  options contributing nothing, decimal exactness where floats drift.
- `apps/public/src/lib/server/commerce.test.ts`: Bearer and `Idempotency-Key` headers, same-key
  same-body retry on timeouts and lost/garbled responses, no retry on semantic failures, error kinds
  and stable codes, fail-closed shapes and redirects, cache bypass, nothing secret in errors or logs.
- `apps/public/src/routes/book/page.server.test.ts`: integration through the real `load` and action
  with only `fetch` replaced by a contract-faithful fake (`src/lib/server/testing/`): version 7
  rendering, contact-only refusal, optional-service drift, unpriceable form, priced body, double
  delivery, lost response, ambiguous then identical same-key retry, unreachable backend, 5xx, 422,
  catalog-state refresh, stale review with a fresh key, replay after a catalog change, key reuse.
- `apps/public/src/routes/book/estimate/server.test.ts`: the preview proxy forwards pricing facts
  only, with the key, and never leaks it.
- `apps/public/src/lib/components/inquiry-field.svelte.test.ts` (browser): backend order, labels and
  descriptions, min/max, AVAILABLE selectable, UNAVAILABLE visible/disabled/named, error association.
- `apps/public/src/catalog-hardcoding.test.ts` and `src/server-boundary.test.ts`: no catalog literals
  in UI code; no private env or `$lib/server` in client-reachable code.
- `apps/public/e2e/booking/*.e2e.ts`: the real browser against the production build and the stub API
  (`e2e/stub-commerce.mjs`, which implements the idempotency contract, offering availability and the
  required `pricingInputs`): rendering order, unavailable chips, no contact-only path (with and
  without JavaScript), estimate, submit, lost response, frozen retry, deliberate restart, stale
  review, reused key, same-origin-only traffic, no secrets in HTML, `__data.json` or the client build.
