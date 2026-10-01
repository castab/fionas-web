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
                                (first need, or token due) ─────────────▶  POST /auth/service/token
                                ◀── access token (memory)                   { serviceId, secret }
 GET /book  ─────────────────▶  load: getInquiryForm() ─────────────────▶  GET /inquiry-form
 ◀── form + submissionToken
 POST /book/estimate (JSON) ──▶  previewEstimate()  ────────────────────▶  POST /estimate-preview
 POST /book (form action) ────▶  submitInquiry() → createInquiry() ─────▶  POST /inquiries
   submissionToken,                                Authorization: Bearer <access token>
   catalogRevision, answers                        Idempotency-Key: <submissionToken>
 ◀── 303 /book/received  (or the form again, with a recoverable state)
```

- **Service credentials are server-only.** The site is `SERVICE:fionas-web` at the backend.
  `COMMERCE_SERVICE_ID` and `COMMERCE_SERVICE_CREDENTIAL` are read through `$env/dynamic/private` in
  exactly one file, `apps/public/src/lib/server/commerce.ts`, at request time, so their values are
  never inlined into any build output; only `service-auth.ts` sends them anywhere (the token
  endpoint). The access tokens they buy live in server memory only. SvelteKit refuses to bundle
  `$lib/server` or private env into client code, and `src/server-boundary.test.ts` fails if any
  client-reachable source (routes, components, `@fionas/ui`, `@fionas/shared`) imports them. Neither
  the credential nor a token is ever logged, returned in page data, set in a cookie or echoed in
  errors; the e2e suite checks `/book`, `__data.json`, `/book/estimate`, cookies and every file in
  `build/client`.
- **The browser only talks to the SvelteKit origin.** The backend sends no CORS headers and none
  are needed; CORS is not the security mechanism. The browser never learns the backend's address
  (`COMMERCE_API_URL`, shared with the admin app).
- **Page data is safe to show.** The browser receives the inquiry form definition (the backend's
  public form), a submission token, and, after a failed submit, its own answers and a customer-facing
  message. Backend diagnostic messages are never rendered or parsed.
- **Credentials are provisioned by hand.** A staff administrator creates the service, its
  `fionas.web` role and a credential (README, "Service authentication"); the app never provisions or
  rotates anything itself. No OAuth, refresh tokens or JWT handling in the frontend.

| Variable                      | Where           | Purpose                                                              |
| ----------------------------- | --------------- | -------------------------------------------------------------------- |
| `COMMERCE_API_URL`            | private, server | fionas-commerce base URL (default `http://localhost:8080`)           |
| `COMMERCE_SERVICE_ID`         | private, server | UUID of `SERVICE:fionas-web`                                         |
| `COMMERCE_SERVICE_CREDENTIAL` | private, server | its credential secret, exchanged for access tokens                   |
| `BOOKING_ENABLED`             | private, server | `true` serves `/book`; otherwise it 404s and CTAs show "coming soon" |

## Service authentication

`service-auth.ts` holds the site's SERVICE identity; `commerce.ts`' `createCommerceClient` uses it
for every call. One client (and so one token) per server process, created from env on first use.

- **Lazy.** Nothing happens at startup: the marketing site runs without credentials. The first call
  that needs the backend checks them (missing or not a UUID: logged once, "unavailable") and
  exchanges them at `POST /auth/service/token`.
- **In memory only.** A successful exchange caches `{ accessToken, expiresAt, refreshAt }` in the
  client's closure; never in cookies, files, page data or env. Expiry comes from the response's
  `expiresIn`, counted from when the request was sent; the token is opaque and never decoded.
- **Refreshed early.** A token is replaced once `refreshAt` passes: a tenth of its lifetime before
  expiry, at least 1 s, at most 60 s, never more than half the lifetime (a 15-minute token a minute
  early). If that refresh fails while the old token is still unexpired, the old one is used.
- **One exchange at a time.** The backend verifies credentials with memory-hard Argon2, so requests
  that find no usable token share a single in-flight exchange, which is released on success and
  failure alike.
- **401: one retry.** The token that was refused is dropped only if it is still the cached one (a
  newer token another request installed survives), a current token is obtained, and the identical
  request (same body bytes, same `Idempotency-Key`) is sent once more. A second `401` is final.
- **403: no retry.** The service authenticated but lacks the permission; the backend resolves
  grants live, so a new token can't help.
- **Failures are outages.** No usable token (credential missing or refused, token endpoint
  unreachable or answering outside the contract), a final `401` or a `403` is a `service_auth`
  error: nothing was processed. The server logs a safe operator hint, such as
  `[commerce] service token exchange failed → 401; check COMMERCE_SERVICE_ID / COMMERCE_SERVICE_CREDENTIAL`
  or `[commerce] POST /inquiries → 403; check fionas-web service permissions (needs fionas.inquiries.create)`
  (method, path, status, hint; never a credential, token, header or body). Visitors see only the
  generic "unavailable" copy: `/book` shows no form, the action reports `unavailable` ("hasn't been
  sent"), and `/book/estimate` answers `503 {"code":"unavailable"}`, so the page keeps its advisory
  estimate rather than treating the choices as rejected.

## Code map

| Concern                                                  | File                                                   |
| -------------------------------------------------------- | ------------------------------------------------------ |
| HTTP to fionas-commerce (URL, auth, timeout, errors)     | `apps/public/src/lib/server/commerce.ts`               |
| SERVICE credential → access token (cache, refresh)       | `apps/public/src/lib/server/service-auth.ts`           |
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

`commerce.ts` owns the base URL, service authentication (above), request construction, JSON
decoding, an 8 s timeout and error decoding. Route files never call `fetch` on the backend. Operations:
`getInquiryForm({ fresh })`, `previewEstimate(pricingInputs)` and
`createInquiry(request, idempotencyKey)`. Every result is `{ ok: true, data }` or
`{ ok: false, error }`, where `error` keeps the backend's stable `code` and violation codes and adds
a `kind`:

| `kind`         | Meaning                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `validation`   | `400` / `422`: refused; nothing written                                                            |
| `not_found`    | `404`: catalog not initialized or unknown revision                                                 |
| `conflict`     | `409`: `CATALOG_REVISION_STALE`, `IDEMPOTENCY_KEY_REUSED`, `conflict`                              |
| `service_auth` | no usable service token, or a final `401` / `403`: not processed (logged for the operator)         |
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
in version 7 only "Additional information" is optional, and it alone shows an "Optional" badge. The
UI applies the flag exactly as sent (`isSkippable`) and never reinterprets it. A definition that is
incompatible with `POST /inquiries` is rejected as a whole (`pricingContractProblem`): a section with
pricing questions (pointers under `/pricingInputs/`) marked optional, no guest-count or duration
question, or a pricing pointer this UI doesn't understand. Such a form is never coerced into a
required one: `/book` offers no form ("isn't available right now"), the action sends nothing (not even
complete answers), a stale refresh offers nothing to review, and the server logs
`GET /inquiry-form is incompatible with POST /inquiries (…)` once.

**The submit gate.** `prepareInquiry(form, answers)` in `@fionas/shared` is the only way to build a
`POST /inquiries` body, used by both the browser (before posting) and the form action (before
sending). It validates every question that applies, then maps answers by pointer and checks the
transport floor again: a catalog revision, a whole-number guest count, a duration, and a selection
block meeting every category's minimum, and every other field the backend requires (`name`, `email`,
`zipCode`, `eventDate`, and an `eventType` from the backend's enum, `INQUIRY_EVENT_TYPES`). It
returns `invalid` (field errors) or `incompatible` (the form itself can't produce a valid request)
instead of a request, so there is no state equivalent to `pricingInputs: undefined`.

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
| form unreadable or incompatible before sending; service auth failed (`service_auth`)         | `unavailable`  | "hasn't been sent"; edit freely, send again                            | kept |
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
  contact-only or partial request can be built, and that an incompatible definition (an optional
  service section, missing pricing questions) is rejected rather than coerced, even with complete
  answers; section skippability, pointer mapping, reconciliation (unavailable, removed, raised
  minimum, lowered maximum).
- `packages/shared/src/estimate.test.ts`: every price form against synthetic prices, unavailable
  options contributing nothing, decimal exactness where floats drift.
- `apps/public/src/lib/server/service-auth.test.ts`: the token lifecycle with an injected clock:
  lazy exchange, reuse, one exchange for concurrent callers (released on failure), early refresh
  (15-minute and short tokens), fallback to an unexpired token, race-safe invalidation, refused /
  unreachable / malformed exchanges and missing config, never leaking the credential.
- `apps/public/src/lib/server/commerce.test.ts`: service token and `Idempotency-Key` headers,
  same-key same-body retry on timeouts and lost/garbled responses and the retryable `conflict`, no
  retry on semantic failures, error kinds and stable codes, fail-closed shapes and redirects, cache
  bypass; through `createCommerceClient`: lazy acquisition, reuse, singleflight, early refresh, `401`
  recovery repeating the identical request exactly once, no second auth retry, a slow `401` not
  discarding a newer token, `403` on each endpoint never refreshed, unusable token responses, and an
  unknown outcome staying unknown when the retry can't authenticate; nothing secret in results or logs.
- `apps/public/src/routes/book/page.server.test.ts`: integration through the real `load` and action
  with only `fetch` replaced by a contract-faithful fake (`src/lib/server/testing/`): version 7
  rendering, contact-only refusal, an optional-service definition rejected (on load, on submit and on
  stale refresh), an incompatible form, priced body, double delivery, lost response, ambiguous then
  identical same-key retry, unreachable backend, 5xx, 422, catalog-state refresh, stale review with a
  fresh key, replay after a catalog change, key reuse.
- `apps/public/src/routes/book/estimate/server.test.ts`: the preview proxy forwards pricing facts
  only, with the service token, never leaks it, survives an expired token, and reports a refused
  credential or a `403` as `503 unavailable`, never as a rejected selection.
- `apps/public/src/lib/components/inquiry-field.svelte.test.ts` (browser): backend order, labels and
  descriptions, min/max, AVAILABLE selectable, UNAVAILABLE visible/disabled/named, error association.
- `apps/public/src/catalog-hardcoding.test.ts` and `src/server-boundary.test.ts`: no catalog literals
  in UI code; no private env or `$lib/server` in client-reachable code.
- `apps/public/e2e/booking/*.e2e.ts`: the real browser against the production build and the stub API
  (`e2e/stub-commerce.mjs`, which issues opaque tokens for the test-only service credential in
  `e2e/test-service.ts` and implements the idempotency contract, offering availability and the
  required `pricingInputs`): rendering order, unavailable chips, no contact-only path (with and
  without JavaScript), estimate (kept on a `503` or a service `403`), submit, lost response, frozen
  retry, deliberate restart, stale review, reused key, double delivery recorded once, an expired
  token replaced under the same key, a `403` shown as an outage, same-origin-only traffic, no
  credential or token in HTML, `__data.json`, `/book/estimate`, cookies or the client build. The
  gated preview runs without service credentials.
