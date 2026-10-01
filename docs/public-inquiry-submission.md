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

| Concern                                                | File                                               |
| ------------------------------------------------------ | -------------------------------------------------- |
| HTTP to fionas-commerce (URL, key, timeout, errors)    | `apps/public/src/lib/server/commerce.ts`           |
| Submission flow (token, revision, outcomes, receipt)   | `apps/public/src/lib/server/inquiry-submission.ts` |
| Failure payload type + customer copy (client-safe)     | `apps/public/src/lib/inquiry-submission.ts`        |
| Form load + action                                     | `apps/public/src/routes/book/+page.server.ts`      |
| Form UI (token/revision hidden fields, review, errors) | `apps/public/src/routes/book/+page.svelte`         |
| Confirmation page                                      | `apps/public/src/routes/book/received/`            |
| Answer mapping, validation, stale reconciliation       | `packages/shared/src/inquiry.ts`                   |

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
| Outage, timeout, `5xx`                              | kept                                           |
| `CATALOG_REVISION_STALE` → refreshed form to review | new (the reviewed form is a new submission)    |
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

| Backend answer                         | Customer sees                                                | Key  |
| -------------------------------------- | ------------------------------------------------------------ | ---- |
| `201` (new or replayed — same receipt) | `/book/received`: reference + time, "not a booking"          | done |
| `409 CATALOG_REVISION_STALE`           | refreshed form + "Our menu changed" review notice            | new  |
| `409 IDEMPOTENCY_KEY_REUSED`           | "doesn't match…" + deliberate "Send as a new request"        | kept |
| `422 validation_failed`                | form error from stable violation codes (`describeViolation`) | kept |
| `400` / `404`                          | generic "review your answers" / "menu changed, reload"       | kept |
| network error, timeout, `5xx`, `401`   | "couldn't confirm… sending again won't create a duplicate"   | kept |

**Success.** The receipt (`id`, `createdAt`) goes into a short-lived `HttpOnly` cookie and the action
redirects (`303`) to `/book/received` (post/redirect/get), so reloading or navigating never re-posts.
A replayed `201` is indistinguishable and treated the same. The app never reads staff-only
`/inquiries/{id}` and never sees Estimate ids.

**Stale catalog.** The action never resubmits. It re-reads `GET /inquiry-form` with
`cache: 'no-store'` and `Cache-Control: no-cache`, fits the answers to it with `reconcileAnswers`
(contact and event answers kept; a retired offering or option dropped, never substituted; pick lists
that no longer fit their limits left for validation to flag) and returns the new form, the
reconciled answers, the labels of questions to look at again and a new token. The page renders the
new form and estimate with a notice, and the customer must press Send again.

**Reused key.** Not retried automatically: that could hide a token-lifecycle bug or an ambiguous
earlier submission. The server logs `[inquiry] Idempotency-Key … was already used` (the key is not
secret) and offers a `restartToken`; the customer's explicit "Send as a new request" submits the
current answers under it.

## Retries and network ambiguity

A failed or timed-out request does not prove the backend failed: it may have committed before the
response was lost. `createInquiry` therefore retries **once**, after 250 ms, **with the same key**,
when the outcome is unknown or transient: fetch threw (refused, reset, 8 s timeout), a `2xx` body
could not be read, `502`/`503`/`504`, or the backend's documented retryable `409 conflict`
(concurrent customer creation). It never retries `400`, `404`, `422`, `CATALOG_REVISION_STALE`,
`IDEMPOTENCY_KEY_REUSED` or `500`. If the retry fails too, the customer gets the recoverable state
above with the same token, so pressing Send again is also safe.

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
  and plain bodies, double delivery, lost response, outage then manual retry, 5xx, 422, stale
  review with a fresh key, replay after a catalog change, key reuse and deliberate restart.
- `apps/public/src/server-boundary.test.ts`: no private env or `$lib/server` in client-reachable code.
- `apps/public/e2e/booking/submission.e2e.ts`: the same scenarios in a real browser against the
  production build and the stub API (`e2e/stub-commerce.mjs`, which implements the idempotency
  contract), plus same-origin-only browser traffic and no secrets in HTML, `__data.json` or the
  client build.
