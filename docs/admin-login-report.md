# Admin login: implementation report

Closing report for the first admin feature (sign-in, session cookie, guard, sign out). Architecture is
in [admin-architecture.md](admin-architecture.md). Everything below was verified against the stub API
(unit, e2e, and by hand in the browser); **nothing was run against the real `fionas-commerce` backend**.

## Issues encountered, and what it takes to fix each

| #   | Issue                                                                                                                                                                                                                                                                                  | Status                   | What it would take                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Not tested against the real API.** The stub encodes our reading of the spec (cookie shape, `Origin` check, status codes).                                                                                                                                                            | Open                     | Run `fionas-commerce` locally, add `http://localhost:5174` to its trusted origins, set `COMMERCE_API_URL`, and do the manual login/logout from the plan once (about 15 min, backend owner may need to supply a user). Fix any difference in `stub-commerce.mjs` and `auth.test.ts` so they keep matching reality. |
| 2   | **Trusted origins are a backend config.** Login returns 403 unless the API trusts each admin origin (`localhost:5174`, `admin-dev…`, `admin…`). The spec doesn't say where that list is set.                                                                                           | Open (outside this repo) | Add the three origins in the backend's config for each environment. The admin server logs `[backend] POST /auth/login → 403 …is "<origin>" a trusted origin on the API?` to make it obvious. Also set `ADMIN_ORIGIN` on Railway, because behind a proxy the request's own origin may be an internal host.         |
| 3   | **The session cookie's name and format aren't in the spec.** The real API sends `__Host-fionas_session="<token>"` (http4k quotes the value). SvelteKit's default `encodeURIComponent` re-issued it as `%22<token>%22`, so `/auth/me` rejected it and sign-in bounced back to `/login`. | Fixed                    | `applySetCookies` re-issues values verbatim (`encode`), and the stub now uses the real name and quoting so e2e catches a regression. If the backend ever sets more than one cookie or `Domain`/`Partitioned` attributes, extend `parseSetCookie` (it ignores unknown attributes and forces `Path=/`).             |
| 4   | **Deploy health checks.** The guard redirects every path except `/login` to `/login` (303). A Railway healthcheck against `/` or `/health` would not get a 200.                                                                                                                        | Open, latent             | Add a `/health` endpoint and a public-path allowlist in `hooks.server.ts` (`const PUBLIC = new Set(['/login', '/health'])`) when the service is deployed (about 10 lines + a test).                                                                                                                               |
| 5   | **Expired session mid-use.** A lapsed cookie silently lands the user on `/login`; they're not returned to the page they wanted and aren't told why.                                                                                                                                    | Open, UX                 | In the hook, redirect to `/login?redirectTo=<path>`, validate it is a same-site relative path in the login action, and redirect there after sign-in. Optionally show an "Your session ended" notice. Needs e2e coverage (about half a day with tests).                                                            |
| 6   | **`GET /auth/me` on every page request.** Simple and always correct (revocation is instant) but adds a backend round trip per navigation.                                                                                                                                              | Accepted for now         | If it shows up in latency, cache the `StaffUser` per session token in-memory for ~30s in the hook, and bust it on logout. Trade-off: revocation lags by the TTL.                                                                                                                                                  |
| 7   | **Tab title stuck on "Sign in" after login.** Svelte doesn't restore an earlier `<title>` when a page's `<svelte:head><title>` unmounts, and the root layout also set one. Caught by the shell e2e test.                                                                               | Fixed                    | Each page now sets its own `<title>`; the root layout sets none. Every new page must set a title.                                                                                                                                                                                                                 |
| 8   | **Worktree had no `node_modules`**, and `package-lock.json` changed when `vitest` was added to admin.                                                                                                                                                                                  | Fixed                    | `npm install` (Node 26.9.0). Commit the lockfile change with the feature.                                                                                                                                                                                                                                         |
| 9   | **`AGENTS.md` had duplicated table rows** and still called admin a placeholder.                                                                                                                                                                                                        | Fixed                    | Cleaned and updated, plus a rule recording that all backend calls go through the server.                                                                                                                                                                                                                          |
| 10  | **Browser coverage is Chromium only** (Playwright desktop + Pixel 7). A `Secure` cookie on `http://127.0.0.1` works there; Firefox/Safari behaviour for local HTTP wasn't tested.                                                                                                      | Open, low                | Add `firefox`/`webkit` projects to `apps/admin/playwright.config.ts` and run the login spec; if `127.0.0.1` misbehaves, switch the e2e origin to `localhost` (which SvelteKit treats as non-secure-required).                                                                                                     |
| 11  | **Design fidelity.** Prototype hexes (e.g. `#3d3a2b`, `#f6f1e4`) were mapped to the closest design tokens rather than added as raw values (per `AGENTS.md`), so a few shades differ slightly; the logo uses the `Wordmark` component, not the prototype's CSS-masked SVG.              | Accepted                 | If pixel parity matters, compare against the design project's screenshot and adjust token choices (or add a token) in `login/+page.svelte`.                                                                                                                                                                       |
| 12  | **No lockout/rate-limit UX beyond the message.** The API limits per connection IP (burst 5, 1 per 5 min); the page shows the wait time but nothing stops further clicks.                                                                                                               | Accepted                 | Optionally disable the button for `retryAfter` seconds client-side. Note behind a shared proxy IP, all staff share one bucket; confirm the backend sees the real client IP (`X-Forwarded-For`) in production.                                                                                                     |

## Enabling "Remember me" in a future iteration

The prototype has a "Remember me on this device" checkbox; it was left out because `POST /auth/login`
accepts only `username` and `password`. The session's lifetime is decided by the backend, so the
backend has to change first. Re-issuing a longer-lived cookie from the admin server alone would not
help: the API would still expire the session on its side, leaving a cookie that points at a dead
session.

**Backend (fionas-commerce)**

1. Extend `LoginRequest` with an optional `rememberMe: boolean` (default `false`) and update the OpenAPI spec.
2. When `true`, issue a long-lived session (for example 30 days, sliding or absolute: decide which)
   and set a persistent cookie (`Max-Age`/`Expires`). When `false`, keep today's behaviour: a short
   server-side TTL and a session cookie (no `Max-Age`) that dies with the browser.
3. Decide the policy: maximum remembered lifetime, whether it renews on use, whether roles with
   sensitive permissions (e.g. `commerce.payment.record`) may be remembered at all, and how
   `/auth/logout` and user disabling revoke a remembered session.

**Admin (this repo)**

1. `src/lib/server/auth.ts`: add `rememberMe` to the credentials type and the JSON body of `login()`.
2. `login/+page.server.ts`: read `data.get('rememberMe') === 'on'` and pass it through.
3. `login/+page.svelte`: add `Checkbox` from `@fionas/ui` ("Remember me on this device", as in the
   design: 44px min-height row between the password and the button) inside the existing form.
4. `applySetCookies` / `parseSetCookie` need **no change**: they already preserve `Max-Age` and
   `Expires`, so a persistent cookie from the API becomes a persistent cookie on the admin host and a
   session cookie stays a session cookie.
5. Tests: unit test that the flag reaches the request body; extend `stub-commerce.mjs` to return
   `Max-Age=2592000` when `rememberMe` is true and no `Max-Age` otherwise; e2e asserting the cookie's
   `expires` is `-1` (session) unchecked and about 30 days out when checked; update the "checkbox is
   absent" assertion in `e2e/login.e2e.ts`.
6. Docs: update the cookie section of `admin-architecture.md`, and revisit issue 5 (expired sessions)
   and issue 6 (`/auth/me` caching), which interact with long-lived sessions.

Estimated effort: backend half a day to a day (including policy decisions); admin about two hours
once the API ships it.
