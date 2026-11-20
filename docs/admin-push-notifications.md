# Admin staff push notifications

Staff enroll a browser or the installed admin PWA for Web Push, send themselves a test, and (once
commerce turns it on) get a push for every new catering inquiry. Commerce owns the devices, the
sends and the delivery state ([fionas-commerce `docs/staff-push-notifications.md`](https://github.com/castab/fionas-commerce/blob/main/docs/staff-push-notifications.md));
the admin owns the browser side: the service worker, the subscription, the page and the
same-origin endpoints in front of commerce.

## Flow

```
 Notifications page / (app) shell / service worker
      │  same-origin JSON only (/settings/notifications/*)
      ▼
 +server.ts ─▶ $lib/server/notifications.ts ─▶ request() ─▶ commerce /staff/notifications/*
                (whitelists fields, maps errors       (staff cookie, trusted Origin,
                 to our copy, projects responses)      Idempotency-Key only for the test)
```

1. **Config.** The page's server `load` reads `GET /staff/notifications/config` and, when enabled,
   the device list. Disabled: a calm "aren't available yet" card; nothing registers push or asks for
   permission.
2. **Enable** (a user gesture). `Notification.requestPermission()` is the first call in the click
   handler, then `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` (base64url
   → bytes), then `POST /settings/notifications/subscriptions` with `toJSON()` and an optional label
   (default "Chrome on Mac" etc., editable, ≤ 60 characters). A subscription made with another key
   (VAPID rotation) is unsubscribed first.
3. **This device** is remembered in IndexedDB (`fionas-admin-push` / `device` / `this-device`:
   `{ subscriptionId, label }`), never a cookie or server data. IndexedDB because the service worker
   needs the label too: commerce _replaces_ the label on every re-enrollment, so each one resends it.
4. **409 `push_endpoint_in_use`** on Enable (the browser is still enrolled for another account):
   unsubscribe, subscribe again, enroll the fresh endpoint.
5. **Re-enroll on load.** The `(app)` shell calls `syncThisDevice()` once per page load without
   blocking rendering: with push enabled, permission granted and a subscription present, it POSTs
   it again (same endpoint, same id; keys, expiry, label and `refreshedAt` refresh). A 409 here
   unsubscribes and forgets the device instead of enrolling it silently for whoever is signed in.
   A device removed remotely comes back on its next load, which matches commerce's contract.
6. **Send test.** One `crypto.randomUUID()` key per click, kept until that click has a definite
   answer: an outage or lost answer is retried automatically (twice, 1.5 s apart) and then offered
   as "Try again", always with the same key, so commerce returns the same `notificationId` and
   never sends twice. The page then polls the status every 2 s for up to a minute.
   `push_accepted` is worded as "handed off, not shown" and followed by "Did it appear?".
7. **Your devices.** Label, push service, Active/Expired, enrolled and last-seen dates, and Remove
   (DELETE). Removing this device also unsubscribes locally and forgets it.
8. **Sign out.** The logout form stays a plain POST. With JavaScript, its submit handler first
   (best effort, bounded to 2 s) DELETEs this device, unsubscribes and clears IndexedDB, then
   submits the form. Without JavaScript the form just posts.

## Routes

| Admin route (same origin)                                              | Commerce                                             | Notes                                                                                                                                      |
| ---------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /settings/notifications` (page)                                   | `GET …/config`, `GET …/subscriptions`                | `no-store`; config failure shows "couldn't load".                                                                                          |
| `GET /settings/notifications/config`                                   | `GET /staff/notifications/config`                    | Used by the shell's re-enroll and the service worker.                                                                                      |
| `POST /settings/notifications/subscriptions`                           | `POST /staff/notifications/subscriptions`            | Body whitelisted to `endpoint` (https, ≤ 2048), `expirationTime` (number/null), `keys.p256dh`/`keys.auth` (base64url) and a trimmed label. |
| `GET /settings/notifications/subscriptions`                            | `GET /staff/notifications/subscriptions`             | Answers `{ devices }`, projected to known fields.                                                                                          |
| `DELETE /settings/notifications/subscriptions/{id}`                    | `DELETE /staff/notifications/subscriptions/{id}`     | Non-UUID ids are a local 404.                                                                                                              |
| `POST /settings/notifications/test` `{subscriptionId, idempotencyKey}` | `POST /staff/notifications/test` + `Idempotency-Key` | Key must match `^[A-Za-z0-9_-]{1,128}$`; sent only through `request()`'s `staffTestNotification` capability (8 s).                         |
| `GET /settings/notifications/test/{notificationId}`                    | `GET /staff/notifications/{notificationId}`          | Polled until `push_accepted`, `push_failed` or `skipped`.                                                                                  |

Every answer is `Cache-Control: no-store`. Failures are our envelope `{ code, message }` with our own
copy (`$lib/notifications.ts`), never commerce's message. The codes the client branches on keep
their status: 401 `unauthenticated`, 403 `forbidden`, 404 `not_found`, 409 `push_endpoint_in_use`,
409 `IDEMPOTENCY_KEY_REUSED`, 422 `validation_failed` (also commerce's 400), 503
`push_notifications_disabled`, and 503 `unavailable` for 5xx, timeouts and unreadable answers.
Endpoints, keys and payloads never appear in responses, logs or the page.

## Hooks exception: JSON 401 instead of a login redirect

`hooks.server.ts` still resolves `/auth/me` for these routes, but when the caller is signed out and
`event.route.id` is one of the five push JSON routes above, it answers
`401 {"code":"unauthenticated"}` (`no-store`) instead of `303 /login`, so `fetch` from the page, the
shell and the service worker sees a clean status rather than HTML. Like the SSE exception it is an
exact route-id list; every other route, including the Notifications page itself, keeps the redirect.

## Service worker (`src/service-worker.ts`)

SvelteKit builds and registers it at `/service-worker.js` (scope `/`).

- **No caching, no `fetch` handler.** Admin pages and data are private and `no-store`; nothing is
  served offline. `install` skips waiting and `activate` claims clients, which is safe because there
  is no cache to migrate.
- **`push`:** `parsePushPayload` (`$lib/push-notification.ts`) accepts only `version: 1` with string
  `notificationId`, `title` and `body`, then `showNotification(title, { body, tag: notificationId,
data: { url }, icon, badge })`. The id as `tag` makes a duplicate delivery replace the earlier one.
  An unreadable payload still shows a generic "Fiona's Admin" notification, because Chrome requires
  one per push (`userVisibleOnly`).
- **`notificationclick`:** closes it and opens `safeNotificationPath(url)` or `/`: only a path that
  starts with a single `/` (not `//` or `/\`), with no scheme, backslash, whitespace or control
  character, that still resolves to the admin origin. An absolute URL from a payload is never
  opened. It focuses and navigates an open admin window, or opens a new one.
- **`pushsubscriptionchange`:** uses the event's new subscription, or resubscribes with the old
  one's `applicationServerKey` (else the key from `/settings/notifications/config`), and POSTs it to
  our enroll route with the remembered label. 401/409 are left alone; the next page load re-enrolls.

## Manifest and icons

`static/manifest.webmanifest` ("Fiona's Admin", `start_url`/`scope` `/`, `standalone`, theme
`#5f5b40` olive-700, background `#ede5d3` cream-200) is linked from `app.html` with the
`apple-touch-icon`. The PNGs in `static/icons/` (192, 512, maskable 512, apple-touch 180 and a
monochrome 96 badge) are rendered from `packages/ui/src/assets/logo-badge.svg` by
`node apps/admin/scripts/render-icons.mjs` (headless Chromium; rerun only when the badge changes).
Static files and `/service-worker.js` are served before hooks, so a signed-out browser gets them in
both `vite dev` and the built Node server.

## iOS and iPadOS

Web Push works only in a Home Screen web app on iOS/iPadOS 16.4+. Safari in a tab (detected by the
user agent, or a Mac platform with touch for iPadOS, without `navigator.standalone` or
`display-mode: standalone`) is told to Add to Home Screen first instead of being offered the button;
an installed app without `PushManager` is asked to update iOS.

## Tests

- Unit: `src/lib/server/notifications.test.ts` (every call, whitelisting, key validation, error
  mapping), `backend.test.ts` (the capability), `push-notification.test.ts` (payload and URL
  safety), `push-client.test.ts` (support, labels, keys, copy).
- E2E: `e2e/push-notifications.e2e.ts` against `e2e/push-stub.mjs` (session-scoped, state kept after
  logout; `/__test/push` sets `mode`, `foreignEndpoints`, the status `plan`, `failureReason` and
  `loseTestAnswers`). `PushManager` is faked with `addInitScript` (headless Chromium can't reach a
  push service); the spec runs in Chromium's new headless mode (`channel: 'chromium'`), because the
  old headless shell reports notification permission as denied and can't show notifications. A
  real push is delivered to the service worker over CDP to check the shown notification and tag.

## Manual smoke test (after deploy, with the owner)

1. Owner sets `FIONAS_PUSH_ENABLED=true` in commerce dev. `/settings/notifications/config` on
   admin-dev answers `enabled: true`.
2. Desktop Chrome on admin-dev: Enable, Send test, see the notification, click it (opens the admin).
3. iPhone: Add to Home Screen, open the installed app, Enable, Send test, see the notification.
4. Remove a device from another device: its next test fails or is skipped. Sign out: the device
   disappears from the list.
5. Later the owner sets `FIONAS_PUSH_INQUIRY_NOTIFICATIONS_ENABLED=true`. A new test inquiry shows
   "New catering inquiry", and clicking it opens `/requests/<id>`.
