# Admin Requests index

`/requests` is where staff find any request, whatever its lifecycle stage and whether or not it
needs attention. The dashboard answers "what needs attention?"; the index answers "where is every
request, and how do I find it?". Architecture rules are in
[admin-architecture.md](admin-architecture.md).

## Data flow

The hook resolves the staff user once with `GET /auth/me`. `routes/(app)/requests/+page.server.ts`
then makes exactly one more commerce request, `GET /staff/requests`, through
`src/lib/server/request-list.ts` (`getStaffRequests`, built on `backend.ts`'s `request()`). It
forwards the incoming USER session cookie with the trusted `Origin`, re-issues renewed cookies on
the admin host, never retries, and sets `Cache-Control: no-store`. There are no per-inquiry reads,
no dashboard read, no SERVICE token and no browser-to-commerce calls. The backend requires both
`fionas.inquiries.read` and `commerce.financial-document.read`; the UI never infers access from
role names.

## Backend contract

`listStaffRequests` (fionas-commerce PR #30) takes single-valued `filter` (default `all`), `q`,
`limit` (default 25, 1–100) and `cursor`; repeated or invalid values are `400 malformed_request`.
The admin sends `filter` explicitly, `q` only when non-blank, `cursor` only after page one, and
leaves the page size at the backend's default of 25.

| Filter          | Label         | Backend membership                                    |
| --------------- | ------------- | ----------------------------------------------------- |
| `all`           | All requests  | Every inquiry, including CLOSED and DECLINED          |
| `new`           | New           | REQUESTED                                             |
| `quoted`        | Quoted        | QUOTED                                                |
| `booked`        | Booked        | BOOKED or SERVED                                      |
| `needs-closing` | Needs closing | SERVED with an exactly zero canonical Invoice balance |
| `closed`        | Closed        | CLOSED                                                |
| `declined`      | Declined      | DECLINED                                              |

Booked and Needs closing overlap; Needs closing is not Closed. The frontend implements none of
these predicates. The response is `items`, `totalCount` (all matches before pagination) and
`nextCursor`, which **is omitted on the last page** (CommerceJson drops nulls; an explicit null is
tolerated as the same). `src/lib/request-list-contract.ts` mirrors the item schema.

`isStaffRequestList` (`src/lib/request-list.ts`) checks structure only: an `items` array of items
with identities, known stage/event type/qualifier, boolean `needsClosing`, positive version,
date-only `eventDate`, exact decimal `total`/`balance`, ISO currency and instants; a non-negative
integer `totalCount` no smaller than the page; and an absent, null or non-empty `nextCursor`. A
refused page is **unavailable**, never empty results or a zero balance; the operator log carries
only shapes and counts (`describeRejectedRequestList`), never customer values.

## URL state

The URL is the only state, so every view is bookmarkable, reloadable and works with Back/Forward:
`/requests`, `/requests?filter=quoted`, `/requests?filter=quoted&q=maria`,
`/requests?filter=booked&cursor=…`. `readListQuery` reads it; `listSearch` writes the canonical
form (`all`, a blank search and page one are implicit).

- **Filters** are plain links with `aria-current="page"` on the active one. Changing filter keeps
  the search and drops the cursor.
- **Search** is a native `GET` form (`role="search"`) with a hidden `filter`, so it works without
  JavaScript, keeps the filter and always starts at page one. The backend trims, matches case-
  insensitive name/email substrings or an exact inquiry UUID, and ANDs it with the filter. There is
  no search-as-you-type and no local filtering of the loaded page. Clear search keeps the filter.
- **Pagination** is forward-only: Next page carries the backend's `nextCursor` unchanged (never
  decoded), with the same filter and search. First page restarts; earlier pages are browser
  history. No page numbers or offsets are invented. Pages are not frozen across concurrent
  changes, as the API documents.
- An unknown filter, an over-long (more than 200 characters) or control-character search, a
  malformed cursor or a repeated parameter is recovered locally, without a backend read.

## Presentation

Each result (`src/lib/components/request-list/request-row.svelte`) is one native link to the
workspace showing customer name and event date (a date-only tile, formatted in UTC so it never
shifts), the actual lifecycle stage as a text badge (a Booked result may say **Served**), a
**Needs closing** badge when the backend's `needsClosing` is true, the event date and type, email
and submission date (business timezone), and the current total with its document stage
(`from $985` only for `FROM`). Only an Invoice shows its balance, as secondary text; an Estimate
or Quote balance is not money owed. Amounts go through `formatMoney` without floating point. Rows
keep the backend's order and use `inquiryId` as their key.

## States

| State                        | What staff see                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| Empty, All requests          | "No requests yet. New inquiries will appear here."                                   |
| Empty filter                 | "No quoted requests found." (per filter) and **View all requests**                   |
| Empty search                 | "No requests match “…”." and **Clear search**                                        |
| Empty later page             | "There are no more results here…" and **Start from the first page**                  |
| 400 / invalid URL            | Safe copy and one recovery: first page (stale cursor), Clear search, or all requests |
| 403                          | "This account cannot view requests." No filters, search or counts                    |
| 5xx, network, malformed page | "We couldn’t load requests." and **Try again** (full reload)                         |
| 401                          | Redirect to `/login`, as elsewhere                                                   |

No failure renders results, counts or backend messages.

## Navigation

- The shell's **Requests** entry is a real link on desktop and mobile: `aria-current="page"` on
  `/requests`, `"location"` on `/requests/{inquiryId}`. Dashboard is current only on `/`.
  Calendar, Menu, New quote and Account settings stay disabled.
- The dashboard's four summary tiles are native links (counts unchanged from `/staff/dashboard`):
  New → `?filter=new`, Quoted → `?filter=quoted`, Booked → `?filter=booked`, Needs closing →
  `?filter=needs-closing`. Their accessible names include count and destination; zero-count
  tiles still navigate.

## Return to results

A result links to `/requests/{inquiryId}?from=<list query>`: one parameter holding the list's own
filter, search and cursor, encoded once. `readReturnContext` accepts only those three keys (filter
required, each once, each valid); anything else (an absolute or protocol-relative URL, a path,
other keys) is ignored. The Back link is **rebuilt** from the parsed values onto `/requests`, so it
can never leave the Requests index. With a valid context the workspace shows **← Back to requests**;
without one (opened from the dashboard or directly) it keeps **← Back to dashboard**.

The workspace keeps the context through every link and action: `workspaceSearch` composes it with
the `?quote` / `?payment` / `?decline` panel flags, `workspaceAction` with form actions
(`?quote&from=…&/issueQuote`), and `workspaceRedirect` with each Post/Redirect/Get target. Reload
links and Cancel keep it too. Returning after a mutation shows the authoritative current results:
a request that left the filter is simply gone from it.

## Tests

- Unit: `request-list.test.ts` (URL state, tile mapping, return-context round trips and rejected
  destinations, action composition, validation, presentation), `server/request-list.test.ts`
  (URL/query encoding, cookie, one bodyless GET, missing `nextCursor`, 400/401/403/500/network, no
  retry), `server/requests-index.test.ts` (route load) and `server/request-return.test.ts`
  (workspace load and PRG redirects keep only a valid context).
- E2E: `e2e/requests.e2e.ts` on desktop and mobile covers tiles (keyboard, zero counts), shell
  navigation, all seven filters, one read per load, name/email/partial/case-insensitive/UUID search
  with filters and clearing, cursor pagination with reload and history, the full return journey
  through a deposit and a decline, panel links, malicious return values, forbidden/unavailable/
  malformed/invalid-cursor/unknown-filter states, layout overflow and touch targets, and a
  no-JavaScript journey.
- The stub (`e2e/stub-commerce.mjs`) implements `GET /staff/requests` from each session's live
  request fixtures: filter membership, search, order, `limit`, filter/search-bound cursors, a
  missing `nextCursor` on the final page and 400s. `POST /__test/request` accepts `listMode`
  (`list-forbidden`, `list-unavailable`, `list-malformed`, `list-empty`) and `pageSize`. The
  dashboard summary is derived from the same fixtures, which add a quoted request in no attention
  queue (Sofia), a booked event (Oliver) and a declined request (Hannah). These fixture predicates
  exist only in the stub.

## Deployment dependency

`GET /staff/requests` ships in fionas-commerce PR #30. Until that backend is deployed the index
shows its unavailable state (the endpoint answers 404); dashboard and workspaces are unaffected.
