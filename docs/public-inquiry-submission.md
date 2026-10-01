# Public inquiry submission

How a customer's `/book` request reaches `fionas-commerce`, and what the public SvelteKit app
promises along the way. Read this before changing the booking form, its action or the commerce
adapter.

## Trust boundary

```
 Browser                        Public SvelteKit server                     fionas-commerce
 ───────                        ───────────────────────                     ───────────────
 GET /book  ─────────────────▶  load: getInquiryForm() ─────────────────▶  GET /inquiry-form
 ◀── form + submissionToken                                                 (Bearer UI key)
 POST /book/estimate (JSON) ──▶  previewEstimate()  ────────────────────▶  POST /estimate-preview
 POST /book (form action) ────▶  submitInquiry() → createInquiry() ─────▶  POST /inquiries
   submissionToken,                                Authorization: Bearer <COMMERCE_UI_API_KEY>
   catalogRevision, answers                        Idempotency-Key: <submissionToken>
 ◀── 303 /book/received  (or the form again, with a recoverable state)
```

- **The bearer credential is server-only.** `COMMERCE_UI_API_KEY` is read through
  `$env/dynamic/private` in exactly one file, `apps/public/src/lib/server/commerce.ts`. SvelteKit
  refuses to bundle `$lib/server` or private env into client code, and
  `src/server-boundary.test.ts` fails if any client-reachable source (routes, components, `@fionas/ui`,
  `@fionas/shared`) imports them. The key is never logged, returned in page data or echoed in errors.
- **The browser only talks to the SvelteKit origin.** The backend sends no CORS headers and none
  are needed; CORS is not the security mechanism. The browser never learns the backend's address.
- **Page data is safe to show.** The browser receives the inquiry form definition (the backend's
  public form), a submission token, and, after a failed submit, its own answers and a customer-facing
  message. Backend diagnostic messages are never rendered.
- **Credentials stay simple.** One manually provisioned, rotatable key in deployment env. No OAuth,
  service principals or token exchange.

## Code map

| Concern                                                | File                                                  |
| ------------------------------------------------------ | ----------------------------------------------------- |
| HTTP to fionas-commerce (URL, key, timeout, errors)    | `apps/public/src/lib/server/commerce.ts`              |
| Submission flow (token, revision, outcomes, receipt)   | `apps/public/src/lib/server/inquiry-submission.ts`    |
| Failure payload type + customer copy (client-safe)     | `apps/public/src/lib/inquiry-submission.ts`           |
| Form load + action                                     | `apps/public/src/routes/book/+page.server.ts`         |
| Form UI (token/revision hidden fields, review, errors) | `apps/public/src/routes/book/+page.svelte`            |
| One question, offering chips and availability          | `apps/public/src/lib/components/inquiry-field.svelte` |
| Confirmation page                                      | `apps/public/src/routes/book/received/`               |
| Answer mapping, validation, stale reconciliation       | `packages/shared/src/inquiry.ts`                      |
| Advisory estimate arithmetic                           | `packages/shared/src/estimate.ts`                     |

## The form comes from the backend

`GET /inquiry-form` (definition version 6, `EXPECTED_DEFINITION_VERSION`) is the source of truth for
which questions and options exist. `/book` renders its sections and fields in the order sent,
choosing controls from `input` semantics and the `presentation.control` hint, and maps answers back
through each field's `submissionPointer`. No offering keys, names, prices, category limits or
durations live in UI code (`src/catalog-hardcoding.test.ts` checks this against the captured form).
A different `definitionVersion` is logged once on the server; the self-describing form still renders.

**Offering availability.** Every option carries `selectionState` and `availability`:

| Backend state                   | Public form | UI                                                                                                               |
| ------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `ENABLED` + `AVAILABLE`         | listed      | normal chip, selectable                                                                                          |
| `ENABLED` + `UNAVAILABLE`       | listed      | visible and readable (dashed, muted), native `disabled`, "Unavailable — check back later" in its accessible name |
| `DISABLED` (either), or retired | **absent**  | nothing to show; absence is never presented as "temporarily unavailable"                                         |

Unavailable is temporary: the copy never says sold out, removed or disabled. An unavailable option
contributes nothing to the advisory estimate, and local validation names it if it somehow ends up
in the answers ("Horchata is unavailable right now — please choose another."). A chip already
checked from older answers stays enabled so it can be unchecked. The backend still enforces this
(`422 OFFERING_UNAVAILABLE` / `OFFERING_DISABLED`); the UI only prevents the obvious mistake.

`minSelections`/`maxSelections` drive the "2 picked · choose 1–2" note, disable further chips at the
maximum, and feed local validation. When fewer options are selectable than the minimum, the hint
says so and points to sending a message instead.

**Plain inquiries.** The service section is `optional`. A section counts as started once any of its
non-checkbox questions is answered (`isSectionInUse`); an untouched optional section is neither
validated nor sent, so the request carries no `pricingInputs` and the backend creates no Estimate.
A started section must be completed (the backend's "required applies when the section is used"), and
"Clear these answers" resets it to make the request plain again.

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
`eventDate`, `eventType` and, for a priced inquiry, `pricingInputs` (`catalogRevision`,
`guestCount`, optional `guestCountIsMinimum`, `durationMinutes`, `selections`). Fields map through
each form field's `submissionPointer`. No totals, prices, lines, document or customer ids are sent.

`catalogRevision` is the one the customer saw (from the hidden field), never silently swapped for
the current one. When it still matches the current form the action validates answers locally first
(UX only); when the catalog has moved on it leaves the decision to the backend, which either replays
an earlier commit of this key or answers `CATALOG_REVISION_STALE`.

**Totals in the browser are advisory.** The estimate panel's instant arithmetic and
`POST /estimate-preview` are previews. `POST /inquiries` validates the current catalog, prices once
and atomically creates Estimate v1 for a priced inquiry (none for a plain one). The frontend never
compares its figures with the backend's.

## Outcomes

The action reports one `SubmissionFailure.outcome` per case (`apps/public/src/lib/inquiry-submission.ts`):

| Situation                                                                                      | `outcome`      | Customer sees                                                          | Key  |
| ---------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------- | ---- |
| `201` (new or replayed — same receipt)                                                         | — (303)        | `/book/received`: reference + time, "not a booking"                    | done |
| answers fail the form's own checks                                                             | `invalid`      | inline field errors; nothing sent                                      | kept |
| no usable token or revision posted                                                             | `malformed`    | "This page is out of date"                                             | —    |
| `409 CATALOG_REVISION_STALE`                                                                   | `stale`        | refreshed form + "Our menu changed" notice naming unavailable choices  | new  |
| `422` with a catalog-state violation (below)                                                   | `rejected`     | refreshed form + "Some of your choices need another look"              | new  |
| other `422`, `400`, `404`                                                                      | `rejected`     | form error from stable violation codes (`describeViolation`)           | kept |
| `409 IDEMPOTENCY_KEY_REUSED`                                                                   | `key_reused`   | "We couldn't safely verify this submission…" + "Send as a new request" | kept |
| form unreadable before sending; `401`/`403`                                                    | `unavailable`  | "hasn't been sent"; edit freely, send again                            | kept |
| fetch failed/timed out, garbled `2xx`, `502`–`504`, `conflict` (after the adapter's own retry) | `ambiguous`    | frozen answers, "Try sending again", optional "Change my answers"      | kept |
| `500` or another unexpected status                                                             | `server_error` | "Something went wrong on our side"; send again                         | kept |

Catalog-state violations (`CATALOG_STATE_VIOLATIONS`): `UNKNOWN_OFFERING`, `OFFERING_DISABLED`,
`OFFERING_UNAVAILABLE`, `PUBLIC_INQUIRY_CATEGORY_NOT_ALLOWED`. An honest current page can't produce
them (changing an offering's state advances the revision, so a stale page gets `CATALOG_REVISION_STALE`
first); if one arrives anyway the page was inconsistent or tampered with, so the action does the same
cache-bypassing refresh and review as for a stale catalog, and never resubmits. Behaviour keys off
violation codes only; backend messages are diagnostic and never parsed or shown.

**Success.** The receipt (`id`, `createdAt`) goes into a short-lived `HttpOnly` cookie and the action
redirects (`303`) to `/book/received` (post/redirect/get), so reloading or navigating never re-posts.
A replayed `201` is indistinguishable and treated the same. The app never reads staff-only
`/inquiries/{id}` and never sees Estimate ids.

**Stale catalog.** The action never resubmits. It re-reads `GET /inquiry-form` with
`cache: 'no-store'` and `Cache-Control: no-cache`, fits the answers to it with `reconcileAnswers`
and returns the new form, the reconciled answers, the labels of questions to look at again, the
names of unselected unavailable choices, and a new token:

- name, email, ZIP, event date, message and guest count carry over; event type and duration carry
  over if the new form still offers them
- an offering that is now absent (disabled or retired) is dropped; the notice says generically that
  options changed, since the public form says nothing more about it
- an offering that is now `UNAVAILABLE` stays listed but is unselected, and the notice names it
  ("Horchata is unavailable right now — check back later. We've unselected it…")
- nothing is ever substituted; pick lists that no longer meet the new min/max are left for
  validation to flag, so a category whose only pick became unavailable asks for a new choice
- the notice says prices may have changed; the estimate is recomputed from the new `pricingPreview`

The customer must press Send again; that is a new logical submission under the new token.

**Reused key.** Not retried automatically: that could hide a token-lifecycle bug or an ambiguous
earlier submission. The server logs `[inquiry] Idempotency-Key … was already used` (the key is not
secret) and offers a `restartToken`; the customer's explicit "Send as a new request" submits the
current answers under it.

## Retries and network ambiguity

A failed or timed-out request does not prove the backend failed: it may have committed before the
response was lost. Nothing infers from a timeout whether the inquiry exists. `createInquiry` therefore retries **once**, after 250 ms, **with the same key**,
when the outcome is unknown or transient: fetch threw (refused, reset, 8 s timeout), a `2xx` body
could not be read, `502`/`503`/`504`, or the backend's documented retryable `409 conflict`
(concurrent customer creation). It never retries `400`, `404`, `422`, `CATALOG_REVISION_STALE`,
`IDEMPOTENCY_KEY_REUSED` or `500`. If the retry fails too, the action reports `ambiguous` with the same token.

The page then **freezes the answers**: the field area is `inert` (server-rendered, so this also
holds without JavaScript; inert controls still submit), the primary button becomes "Try sending
again", and the form posts `outcomeUnknown=true`. That retry is byte-for-byte the same request under
the same key, so if the first one committed the backend replays its receipt. While unresolved, a
retry that can't get through (backend unreachable, `5xx`) stays `ambiguous` rather than unfreezing.
Only a definite answer ends it: a receipt, a stale/validation refusal (which commits nothing) or a
reused-key conflict.

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

- `apps/public/src/lib/server/commerce.test.ts`: headers (bearer, `Idempotency-Key`), key format,
  same-key retry on lost/garbled responses and gateway errors, no retry on semantic failures,
  cache bypass, nothing secret in errors or logs.
- `apps/public/src/routes/book/page.server.test.ts`: integration through the real `load` and
  action with only `fetch` replaced by a contract-faithful fake (`src/lib/server/testing/`): priced
  and plain bodies (including skipping the optional service section), double delivery, lost
  response, ambiguous outcome then identical same-key retry, unreachable backend, 5xx, 422, local
  refusal of an unavailable pick, catalog-state 422 refresh, stale review with a fresh key (disabled
  and newly unavailable offerings), replay after a catalog change, key reuse and deliberate restart.
- `apps/public/src/lib/components/inquiry-field.svelte.test.ts` (browser): backend order, labels and
  descriptions, min/max, AVAILABLE selectable, UNAVAILABLE visible/disabled/named, error association.
- `apps/public/src/catalog-hardcoding.test.ts`: no catalog literals in UI code.
- `packages/shared/src/*.test.ts`: validation, optional sections, reconciliation, exact estimate math.
- `apps/public/src/server-boundary.test.ts`: no private env or `$lib/server` in client-reachable code.
- `apps/public/e2e/booking/submission.e2e.ts`: the same scenarios in a real browser against the
  production build and the stub API (`e2e/stub-commerce.mjs`, which implements the idempotency
  contract and offering availability), plus a plain inquiry, the frozen retry and deliberate
  restart, same-origin-only browser traffic and no secrets in HTML, `__data.json` or the client
  build.
