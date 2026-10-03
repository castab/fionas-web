# Admin dashboard scaffold: data report

The first signed-in screen of the admin console, built from the claude.ai/design project's
`Admin Console v4.dc.html` (the "Dashboard" screen and the app shell around it). This report lists every
block of that screen that the commerce API can't power yet, what data each needs, and the smallest
backend change that would supply it. Architecture rules are in [admin-architecture.md](admin-architecture.md).

Everything was checked against `fionas-commerce/build/openapi/fionas-commerce-openapi.json` and the
stub API; **no live backend calls are made by the dashboard yet**.

## What renders today

| Block                                                                | Status          | Source                                                                       |
| -------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------- |
| Sidebar (≥900px) / top header, section nav and account menu (<900px) | Real            | Layout only                                                                  |
| Avatar initials, display name, `@username · role`                    | Real            | `GET /auth/me` (`firstName`, `lastName`, `displayName`, `username`, `roles`) |
| `hi, {first name}`                                                   | Real            | `GET /auth/me`                                                               |
| Today line date ("Saturday, October 3")                              | Real            | Server clock, `America/Los_Angeles`                                          |
| Today line count ("· 4 requests waiting on you")                     | **Hidden**      | See [Waiting count](#waiting-count)                                          |
| Stat tiles: New / Quoted / Booked / Needs closing                    | **Placeholder** | See [Stat tiles](#stat-tiles)                                                |
| Needs a reply                                                        | **Placeholder** | See [Needs a reply](#needs-a-reply)                                          |
| Needs a quote                                                        | **Placeholder** | See [Needs a quote](#needs-a-quote)                                          |
| Needs resolution                                                     | **Placeholder** | See [Needs resolution](#needs-resolution)                                    |

The real components (`StatTile`, `RequestCard`, `RequestGroup`) are built and can be seen with sample
data at **`/?preview` on the dev server** (`npm run dev:admin`). A production build ignores `?preview`
and always shows the placeholders. The sample data lives in `apps/admin/src/lib/dashboard-fixtures.ts`
and goes through the same mapping (`apps/admin/src/lib/dashboard.ts`) that live data will use.

## What the API has today

`GET /inquiries` (paged, newest first, `fionas.inquiries.read`) returns per inquiry: `id`, `customerId`,
`name`, `email`, `message?`, `createdAt`, `zipCode`, `eventDate`, `eventType` (`BIRTHDAY | WEDDING |
CORPORATE | SCHOOL_EVENT | NEIGHBORHOOD_EVENT | OTHER`). There are no status filters.

`GET /inquiries/{id}` adds `pricingInputs` (guest count, `guestCountIsMinimum`, duration, selections).
`GET /inquiries/{id}/financial-documents` returns each document lineage at its latest snapshot:
`stage` (`ESTIMATE | QUOTE | INVOICE`), `total`, and `reconciliation.balance`.

What's missing for the dashboard: a **lifecycle status**, a **message thread**, **quote expiry**, and
**served / closed / declined** markers. Every group and tile also needs the money total on the list
item itself, to avoid one extra call per inquiry.

## Placeholders, one by one

### Stat tiles

Four counts, each opening the request list filtered to that state (navigation comes later).

| Tile          | Counts requests where…                                                   | Colour    |
| ------------- | ------------------------------------------------------------------------ | --------- |
| New           | status is `new` (no quote sent yet)                                      | olive-700 |
| Quoted        | status is `quoted`                                                       | olive-500 |
| Booked        | status is `booked`                                                       | moss-600  |
| Needs closing | status is `served`, **or** status is `closed` and the balance due is > 0 | rust-600  |

**Needs:** a lifecycle status per inquiry, and the balance due (already on
`DocumentReconciliation.balance` for the INVOICE lineage).

**Smallest backend change:** `GET /inquiries/summary` → `{ new, quoted, booked, needsClosing }` (one
cheap call, server-side counting). Or add `status` to `InquiryListItem` and accept a `status` filter on
`GET /inquiries`. Either way, the design's statuses are `NEW | QUOTED | AWAITING_DEPOSIT | BOOKED |
SERVED | CLOSED | DECLINED | NO_RESPONSE | EXPIRED`. `SERVED`, `DECLINED`, `NO_RESPONSE` and `EXPIRED`
have no equivalent anywhere in the API today.

### Needs a reply

Requests whose customer sent the last message and haven't had an answer.

The design's rule (`needsReply`):

- The last thread message is from the customer.
- Staff haven't marked the thread concluded since then (`concludedAt`).
- No decline or final-invoice email went out after it (those count as answers).
- The request isn't `declined` or `no-response`.

**Each card needs:**

| Card field       | Data                                                                          | In API today?                                      |
| ---------------- | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| Name             | `name`                                                                        | Yes                                                |
| Month / day tile | `eventDate`                                                                   | Yes                                                |
| "Waiting N days" | the last unanswered customer message's timestamp                              | **No** (no thread)                                 |
| Event type       | `eventType` label                                                             | Yes (enum; display labels to be decided)           |
| Amount           | current charges: invoice lines, else the quote total, else the estimate total | Partly (financial documents, one call per inquiry) |

**Needs:** a conversation thread per inquiry (direction + timestamp per message), or at least
`lastInboundAt` / `awaitingReply` on the list item, plus a "concluded without reply" marker. Sort:
longest-waiting first.

### Needs a quote

Requests still waiting on a first quote: status `new` and not already in "Needs a reply".

**Card needs:** name, `eventDate`, event type (all in API). "Waiting N days" uses the submission date
(`createdAt`, in API) when there's no thread. Amount is the **estimate total** with a `from ` prefix
when `guestCountIsMinimum`. That total comes from the ESTIMATE financial document; the flag is only on
`GET /inquiries/{id}`.

**Needs:** a status (or a `hasQuote` flag), plus the estimate `total` and `guestCountIsMinimum` on
the list item.

**Interim option, not built:** list inquiries, then call `financial-documents` per inquiry and keep
those with no QUOTE lineage. That costs N+1 calls per dashboard load, has to page through every
inquiry, and needs `commerce.financial-document.read`. It's only worth doing if the backend change is
far off.

### Needs resolution

Quotes that expired without an answer: status `expired`, not already in "Needs a reply". These cards
use the rust date tile (urgent). The amount is the estimate total.

**Needs:** quote `expiresAt` (the design sets it per quote, defaulting to the event date) and an
expired status (or the server computes it), plus the estimate total.

### Waiting count

"· N requests waiting on you" in the today line is the size of **Needs a reply + Needs a quote**. It is
hidden until those groups are live, rather than showing a wrong number.

## Shell gaps

| Item                         | Today                                                        | Needs                                                                                              |
| ---------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Role label ("Administrator") | Humanised from the first role key (`commerce.administrator`) | The role's display name: `GET /admin/access/roles/{roleKey}`, or a `roleNames` field on `/auth/me` |
| Avatar initials              | `firstName` + `lastName`, else the display name              | Nothing (works now)                                                                                |

## Inert controls (next phase)

These render to match the design but do nothing yet. Each is a follow-up screen or action:

- Nav: **Requests**, **Calendar**, **Menu** (sidebar and mobile pill nav). **Dashboard** links to `/`.
- **+ New quote** (sidebar) / **Quote** (mobile header): staff-entered quote form.
- **Account settings**: the account screen.
- Stat tiles: open the request list filtered by status.
- Request cards: open the request detail.

**Sign out** works (the existing `POST /logout` form, in the sidebar and the mobile account menu).

## Assumptions and design deviations

- **Business time zone** is `America/Los_Angeles` (Fresno). "Today" and wait days are counted on that
  calendar (`BUSINESS_TIME_ZONE` in `src/lib/dashboard.ts`). Confirm, or move it into config.
- **Money** is formatted from exact decimal strings, never floats. Whole amounts drop the cents
  (`$415`) and others keep them (`$492.50`), as in the design.
- **Radii:** the design's 12px sidebar nav items use 10px (`rounded-input`), the nearest allowed radius
  (pill / 16 / 10 / 6).
- **Mobile account menu** is a native `<details>` disclosure, so Sign out works without JavaScript. It
  doesn't close on an outside click or Escape yet.
- **Event type labels** in the sample data are the design's free-text ones ("Company picnic"). The
  API's enum has six values, so live cards will need agreed labels (likely from the inquiry form
  definition's options).
- **Preview "today"**: the sample cards' wait labels are pinned to the design's day (Jul 16, 2026),
  while the heading shows the real date.
