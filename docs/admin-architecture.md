# Admin console architecture

How the admin UI (`apps/admin`) and its SvelteKit server work together, and how they reach the
commerce API. Read this before adding a feature.

## The rule

**Every HTTP call to the commerce backend goes through the SvelteKit server.** That covers every
endpoint in `fionas-commerce-openapi.json`: auth, inquiries, financial documents, payments, the
offering catalog, `/admin/access/*`, all of it. The browser only ever talks to the admin origin
(`admin.fionasicecream.com`, `admin-dev.fionasicecream.com`, `localhost:5174`). No backend URL, key or
cookie handling exists in client code.

```
 Browser                      Admin SvelteKit server                    Commerce API
 ───────                      ──────────────────────                    ────────────
 page load / form POST  ───▶  hooks.server.ts ─▶ load / action / +server.ts
 (admin origin only)            │                                   │
                                └─ lib/server/*  ──── fetch ──────▶ /auth/*, /inquiries, …
 HTML / JSON / redirect ◀───    Set-Cookie re-issued on admin host   (COMMERCE_API_URL)
```

Why it has to be this way:

- **No CORS.** The API sends no CORS headers, so a browser on the admin origin can't call it.
- **Host-only session cookie.** `POST /auth/login` sets a `Secure`, `HttpOnly`, host-only cookie. A
  cookie set by the API's host would never be sent to the admin host, so the admin server re-issues it
  on its own host (`applySetCookies`).
- **Trusted `Origin`.** Login and logout require an `Origin` the API trusts. The server sends the admin
  site's origin (`ADMIN_ORIGIN`); browsers can't be relied on to.
- **Secrets stay server-side.** Any future key or service credential lives in server env, never in
  client bundles (see "Environment").

## Where code lives

| Concern                                  | File                                                               |
| ---------------------------------------- | ------------------------------------------------------------------ |
| The one function that calls the API      | `apps/admin/src/lib/server/backend.ts` (`request`)                 |
| Auth calls + cookie translation          | `apps/admin/src/lib/server/auth.ts`                                |
| Env → backend config                     | `apps/admin/src/lib/server/config.ts` (`backendConfig`)            |
| Resolve the signed-in user, guard routes | `apps/admin/src/hooks.server.ts`                                   |
| Typed `locals.user`                      | `apps/admin/src/app.d.ts`                                          |
| Sign-in page + action                    | `apps/admin/src/routes/(auth)/login/`                              |
| Signed-in area (header, sign out)        | `apps/admin/src/routes/(app)/`                                     |
| Sign out                                 | `apps/admin/src/routes/logout/+server.ts`                          |
| Temporary sign-in toast (to be removed)  | `src/lib/toast.svelte.ts`, `src/lib/components/login-toast.svelte` |

Anything under `src/lib/server/` is server-only (SvelteKit refuses to bundle it into the client). New
backend access goes there, built on `request()`; routes call those functions, never `fetch` the API
directly, and components never import from `$lib/server`.

`request(config, path, { method, json, cookie })` returns `ApiResult<T>`:

- `{ ok: true, data, setCookies }` (204 gives `data: null`)
- `{ ok: false, error: { status, code, message, violations }, retryAfter }`

It adds `Origin`, forwards the session `Cookie`, times out after 8s, never follows redirects, maps a
network failure or timeout to `{ status: 503, code: 'unavailable' }`, and never logs cookies or bodies.

## Request lifecycle

1. The browser requests a page on the admin origin, carrying the session cookie.
2. `hooks.server.ts` forwards the `Cookie` header to `GET /auth/me` (`getCurrentUser`). A 200 sets
   `locals.user`; a 401/403, a missing cookie or an unreachable API all read as **signed out**.
3. Signed out and not on `/login` → `303 /login`. Signed in and on `/login` → `303 /`.
4. The route's `load`, form action or `+server.ts` runs with `locals.user`, calling `lib/server/*`
   for any backend data.
5. The response goes back to the browser. Backend `Set-Cookie`s, if any, are applied to the response
   with SvelteKit's `cookies` API.

`/auth/me` runs once per page request. Static assets are served before hooks and don't pay for it.
That is acceptable now; if it becomes a cost, cache the result briefly per session token in the hook.

## Sign-in and the session cookie

1. The login form posts to the `/login` action (works without JavaScript; `use:enhance` upgrades it).
2. The action calls `login()` → `POST /auth/login { username, password }` with `Origin: ADMIN_ORIGIN`.
3. On `204` the API's `Set-Cookie` header(s) are parsed (`parseSetCookie`) and re-issued with
   `cookies.set(...)`: same name and value, `HttpOnly`/`Secure`/`SameSite`/`Max-Age`/`Expires` kept,
   `Path` forced to `/`. The cookie name is not part of the API contract, so none is hard-coded.
4. The action `redirect(303, '/')`s. Client-side, `use:enhance` shows the success toast first and then
   applies the redirect.
5. Later requests carry the cookie to the admin host; the hook forwards it to the API.
6. Sign out (`POST /logout`) calls `POST /auth/logout`, applies the API's clearing `Set-Cookie`, and
   redirects to `/login`. Repeated logout is safe on the API side.

Failures never echo the API's `message` text. `loginFailureMessage` (`src/lib/login.ts`) maps
status → copy: 401 bad credentials, 429 with the wait time from `Retry-After`, 400/422 missing
fields, everything else (403 untrusted origin, 5xx, unreachable) → "unavailable". The API's per-IP
limit is a burst of five attempts refilling one per five minutes.

Because the cookie is `Secure`, SvelteKit sets it with `Secure` too; browsers accept that on
`http://localhost` and `http://127.0.0.1`, so local development works without TLS.

## UI conventions

- **Form actions + `use:enhance`** for mutations: they work without JS, and `fail()` re-renders the
  form with the user's input (never the password).
- **`+server.ts` endpoints** for UI-initiated `fetch`es (e.g. a live preview). They are still server code
  that calls `lib/server/*`; the browser fetches the admin origin, not the API.
- Errors are shown inline with `role="alert"` and are safe to show verbatim (they come from our own copy).
- Svelte 5 runes only, token classes only, `@fionas/ui` components. See `AGENTS.md`.
- The sign-in toast (`toast.svelte.ts`) is temporary feedback while the session flow is brought up;
  delete it and its uses when it is no longer wanted.

## Environment

| Variable           | Required | Purpose                                                                                                               |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `COMMERCE_API_URL` | yes\*    | Commerce API base URL. Defaults to `http://localhost:8080`.                                                           |
| `ADMIN_ORIGIN`     | in prod  | The admin site's public origin, sent as `Origin`. Must be trusted by the API. Falls back to the request's own origin. |

Both are read per request with `$env/dynamic/private`. See `apps/admin/.env.example`. The `/auth/*`
endpoints need no UI key; if later endpoints do, add it to server env only and never log it.

The API must list every admin origin as trusted: `http://localhost:5174`,
`https://admin-dev.fionasicecream.com`, `https://admin.fionasicecream.com`. Otherwise login returns 403
and the server logs `[backend] POST /auth/login → 403 forbidden; is "<origin>" a trusted origin on the API?`.

## Adding a backend endpoint

1. Find it in `fionas-commerce-openapi.json`; note path, method, body, responses, and whether it needs the session
   cookie (most do) or another credential.
2. Add a typed function in `src/lib/server/<domain>.ts` that calls `request()`, passing the incoming
   `cookie` when the call acts as the signed-in user. Return the `ApiResult` (or a narrowed result).
3. Call it from a `load`, form action or `+server.ts` using `backendConfig(url.origin)` and
   `request.headers.get('cookie')`. Don't call it from `.svelte` files.
4. Map failures to our own user-facing copy; don't pass `error.message` through.
5. Unit-test the function with a fake `fetch` (`BackendConfig.fetch`); see `auth.test.ts`.
6. Add the endpoint to `apps/admin/e2e/stub-commerce.mjs` and cover the user flow in a Playwright spec.
7. If the call needs a new env var, add it to `config.ts`, `.env.example` and the table above.

## Local development and tests

```bash
cp apps/admin/.env.example apps/admin/.env   # point COMMERCE_API_URL at a running API
npm run dev:admin                            # http://localhost:5174
npm run test:unit -- --run                   # includes apps/admin (vitest, fake fetch)
npm run test:e2e                             # builds admin and runs it against a stub API
```

E2E never uses the real backend: `apps/admin/e2e/stub-commerce.mjs` implements `/auth/login`, `/auth/me`
and `/auth/logout` (Origin check, `Secure; HttpOnly` cookie, plus the usernames `ratelimited` and
`outage` to simulate 429 and 500) and Playwright starts it beside the admin preview. The real login is
rate limited per IP, so don't point automated tests at it.
