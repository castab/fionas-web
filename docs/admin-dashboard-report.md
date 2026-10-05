# Admin dashboard

The signed-in admin root renders the operational projection from `GET /staff/dashboard`.
It replaces the earlier placeholder and dev-only `?preview` dashboard. Architecture rules are in
[admin-architecture.md](admin-architecture.md).

## Data flow

The hook resolves the staff user once with `GET /auth/me`. The root `+page.server.ts` then makes one
additional commerce request via `src/lib/server/dashboard.ts`, built on `backend.ts`'s `request()`.
It forwards the incoming USER session cookie and re-issues any returned cookies on the admin host.
No SERVICE token, per-inquiry reads, or browser-to-commerce calls are involved. Page responses use
`Cache-Control: no-store` so staff projections are not cached.

`src/lib/dashboard-contract.ts` mirrors the supplied OpenAPI dashboard schemas. Both
`fionas.inquiries.read` and `commerce.financial-document.read` are required by the backend;
frontend role names do not gate access.

## Presentation boundary

- The four summary counts are copied directly from `summary`; they can overlap.
- Each queue renders the corresponding `workQueue.*.items` in returned order. The UI does not
  derive membership from stage, balance, reasons, event date, or financial facts.
- The header counts unique inquiry IDs across all three queues. Overlapping cards remain in each
  queue, while each inquiry contributes once to the header count.
- The header date uses `asOf` in `America/Los_Angeles`. Waiting text counts completed elapsed
  24-hour days between `attentionSince` and `asOf`; sub-day attention says "Waiting less than a day".
  Neither uses the browser's current clock.
- Event tiles treat `eventDate` as a calendar date, with UTC construction and formatting to prevent
  timezone drift.
- Amounts use `total`, `totalQualifier`, and `currency`. Intl formats the exact decimal string
  without converting it to a floating-point number. Whole totals omit decimals; material cents
  retain the currency's precision. Only `FROM` adds "from".
- Event labels translate the API's enum values. The API has no free-text event description, so the
  screenshot's "Company picnic", "Block party", and "Retirement party" become "Corporate event",
  "Neighborhood event", and "Other event".

## States and navigation

Successful empty queues show "You’re caught up here." A forbidden response explains that the
account cannot view the dashboard; other failures show safe unavailable copy and a full reload
link. Failures do not render zero counts or expose backend diagnostic messages.

Queue cards link to `/requests/{inquiryId}` without fetching additional data themselves; summary
tiles remain presentational. New quote, the Requests index, Calendar, Menu, and Account settings
remain disabled. The request workspace highlights Requests without providing a fake index link.
Sign out remains available in the sidebar and mobile disclosure, including without JavaScript.

See [admin-request-workspace.md](admin-request-workspace.md) for request review and Quote issuance.

## Validation

Unit tests cover the server client and presentation helpers. The admin E2E stub implements auth
and the dashboard with session-scoped empty, overlap, forbidden, and unavailable scenarios.
Desktop and mobile Playwright coverage verifies the projection, read counts, retry, safe failures,
responsive overflow, and existing login/logout behavior.
