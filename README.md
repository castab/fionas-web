# fionas-web

Websites for **Fiona's Ice Cream**, a towable ice cream trailer serving Fresno & the Madera Ranchos
([@fionasicecream](https://www.instagram.com/fionasicecream/)).

npm-workspaces monorepo:

```
fionas-web/
├── apps/
│   ├── public/          # marketing site (SvelteKit) — the landing page today
│   └── admin/           # staff console (SvelteKit) — sign-in so far
├── packages/
│   ├── ui/              # @fionas/ui — Svelte 5 components (Button, Badge, Card, Wordmark, toast…)
│   ├── design-tokens/   # @fionas/design-tokens — brand CSS tokens + Tailwind v4 theme
│   └── shared/          # @fionas/shared — framework-agnostic constants (site details, copy)
└── package.json
```

## Stack

- Svelte 5 (runes only) + SvelteKit 2 on Vite 8, `adapter-node`
- Tailwind CSS v4 (CSS-first config) + shadcn-svelte conventions (`tailwind-variants`)
- Vitest (browser mode for components) + Playwright (e2e)

## Getting started

Node **v26.9.0** is required (`.nvmrc`; `engine-strict` enforces it).

```bash
nvm use
npm install
npm run dev          # public site on http://localhost:5173
npm run dev:admin    # admin on http://localhost:5174
```

## Booking form & backend

`/book` is an inquiry form driven by the `fionas-commerce` API (`GET /inquiry-form`,
`POST /estimate-preview`, `POST /inquiries`). The backend sends no CORS headers, so the public app
calls it server-side only. Copy `apps/public/.env.example` to `apps/public/.env` (git-ignored; restart the dev server after editing) to configure:

| Variable                      | Default                 | Purpose                                                                                                            |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `COMMERCE_API_URL`            | `http://localhost:8080` | Base URL of the commerce API                                                                                       |
| `COMMERCE_SERVICE_ID`         | unset                   | UUID of the site's SERVICE principal, `SERVICE:fionas-web` (see [Service authentication](#service-authentication)) |
| `COMMERCE_SERVICE_CREDENTIAL` | unset                   | That service's credential secret. Secret                                                                           |
| `BOOKING_ENABLED`             | unset (off)             | `true` enables `/book` and links the Book buttons to it; off: `/book` is a 404 and the buttons show the toast      |

The service variables are needed only while booking is on: the marketing site starts and runs
without them, and they are checked when `/book` first needs the backend (missing or refused, `/book`
shows its "unavailable" page and the server log says why). Keep them only in the git-ignored
`apps/public/.env` (or your host's secret store), never in `.env.example` or client code. They are
read through SvelteKit's private env in `src/lib/server/`, so they cannot be bundled into the
browser.

While `BOOKING_ENABLED` is off, `/book` (page, form action and estimate endpoint) returns 404. E2E tests use a stub API, so they need no running backend.

Every inquiry is a request for configured ice cream service: the form won't send until guest
count, duration and the required flavor/topping/cone choices are complete, and the backend prices
each accepted inquiry into its initial Estimate. The estimate shown while filling in is advisory.

Each rendered form carries one non-secret submission token, which the server sends as
`POST /inquiries`' `Idempotency-Key` for every delivery and retry of that submission, so double
clicks, lost responses and retries never create duplicate inquiries. A changed catalog
(`CATALOG_REVISION_STALE`) refreshes the form for the customer to review; nothing is resubmitted for
them. See [docs/public-inquiry-submission.md](docs/public-inquiry-submission.md).

### Service authentication

The public site calls fionas-commerce as a first-class SERVICE principal, never as a user and
never with a static key:

```
browser
  │  same-origin requests only (/book, /book/estimate); receives no credential or token
  ▼
apps/public SvelteKit server (src/lib/server/)
  │  COMMERCE_SERVICE_ID + COMMERCE_SERVICE_CREDENTIAL (private deployment env)
  ▼
POST /auth/service/token  →  short-lived access token (15 min by default), kept in server memory
  │  Authorization: Bearer <access token>
  ▼
fionas-commerce  →  SERVICE:fionas-web  →  role fionas.web  →  fionas.inquiry-form.read
                                                               fionas.estimate-preview.create
                                                               fionas.inquiries.create
```

Three different secrets are involved, and they are never interchangeable:

| Secret                           | Held by                                | Purpose                                                    |
| -------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| `SERVICE_TOKENS_SIGNING_KEY`     | fionas-commerce only                   | Signs access tokens. This app never has it                 |
| Service credential (id + secret) | apps/public's private deployment env   | Long-lived; exchanged for access tokens                    |
| Access token                     | apps/public server memory, per process | Short-lived `Authorization: Bearer`; carries identity only |

The browser receives none of them. The server obtains a token lazily, reuses it until shortly
before it expires, shares one exchange between concurrent requests, and after a `401` gets a new
one and repeats the request once. A `403` (the service lacks a permission) is never retried. After a
failed exchange the next one waits (5 s, doubling to at most 60 s, or the token endpoint's
`Retry-After`), so a wrong or revoked credential can't drive repeated expensive verifications. Both are
logged for the operator (`[commerce] POST /inquiries → 403; check fionas-web service permissions`)
and shown to visitors only as the generic "unavailable" message. Details:
[docs/public-inquiry-submission.md](docs/public-inquiry-submission.md#service-authentication).

`apps/admin` is intentionally separate: staff sign in with their own USER sessions and the admin
server never authenticates as `SERVICE:fionas-web`.

**Provisioning (once per environment, by a staff administrator; never at startup).** Run the
script and answer its prompts: the backend URL, then the administrator's username and password
(the bootstrap administrator holds every permission needed):

```bash
npm run provision:service
```

It signs in as that administrator through the backend's `/admin/access` API, and then:

1. Creates the service `fionas-web` (`POST /admin/access/services`), or reuses it.
2. Creates the role `fionas.web` (`POST /admin/access/roles`), granting exactly
   `fionas.inquiry-form.read`, `fionas.estimate-preview.create` and `fionas.inquiries.create`
   (never staff, offering-management, financial, role or credential permissions). If the role
   exists with other grants, they are reset to exactly these.
3. Assigns it (`PUT /admin/access/services/{serviceId}/roles/fionas.web`) if it isn't already.
4. Creates a credential (`POST /admin/access/services/{serviceId}/credentials`). The backend shows
   the `secret` exactly once, so every run creates a new credential and never revokes the old ones.
5. Writes `COMMERCE_API_URL`, `COMMERCE_SERVICE_ID` and `COMMERCE_SERVICE_CREDENTIAL` into
   `apps/public/.env`, keeping the other lines. If that file already holds service credentials it asks
   before replacing them.

For a deployment, `npm run provision:service -- --print` prints the three variables instead of
writing a file, to paste into the host's secret store. The app never stores them anywhere else. Other
options (`--url`, `--username`, `--origin`, `--out`, `--yes`): `npm run provision:service -- --help`.
The login is sent with an `Origin` header, which must be a trusted origin on the API; it defaults to
the backend URL's own origin, and `--origin` overrides it.

**Rotation (no downtime, no backend restart).** With credential A active: create credential B
(run the script again), deploy B to apps/public, verify that `/book` loads, previews an estimate and submits, then
revoke A (`DELETE /admin/access/services/{serviceId}/credentials/{credentialId}`). Tokens A already
bought stay valid until their configured expiry (15 minutes by default); that is expected. After a suspected
compromise, also disable the service (`PUT /admin/access/services/{serviceId}/status`) until that
lifetime has passed.

### Local smoke test against a real backend

1. Start fionas-commerce locally (see its README) with `SERVICE_TOKENS_SIGNING_KEY`
   (`openssl rand -base64 32`), `SERVICE_TOKENS_ISSUER=fionas-commerce-local`,
   `FIONAS_TRUSTED_ORIGINS=http://localhost:8080`, the bootstrap administrator variables, and a
   seeded catalog (`node scripts/setup-local-commerce.mjs` there).
2. Provision the site's service identity and credentials (backend URL `http://localhost:8080`,
   then the bootstrap administrator's username and password):

   ```bash
   npm run provision:service
   ```

3. Set `BOOKING_ENABLED=true` in `apps/public/.env` (the script already wrote the three
   `COMMERCE_*` variables there) and run `npm run dev`. Never copy an access token anywhere: the
   app obtains its own.
4. Visit `http://localhost:5173/book`: the form loads, choosing guests, duration and flavors shows
   the estimate (the authoritative preview replaces the instant one), and sending shows
   "Request received" with a reference.
5. Confirm in the backend, as the bootstrap administrator (sign in at `POST /auth/login`, then send
   the session cookie and an `Origin` header), that the inquiry and its Estimate v1 exist:
   `GET /inquiries/<reference>` and `GET /inquiries/<reference>/financial-documents`.

If `/book` says it isn't available, the dev server's log names the cause, for example
`service token exchange failed → 401; check COMMERCE_SERVICE_ID / COMMERCE_SERVICE_CREDENTIAL` or
`GET /inquiry-form → 403; check fionas-web service permissions (needs fionas.inquiry-form.read)`.

## Admin console

`apps/admin` is the staff console (`admin.fionasicecream.com` / `admin-dev.fionasicecream.com`). Staff sign in with
their commerce API account; the admin server logs in on their behalf and keeps the session cookie on the admin
host. **All backend calls go through the SvelteKit server**; see [docs/admin-architecture.md](docs/admin-architecture.md).
It uses each staff member's own USER session, never the public site's SERVICE credential.
Copy `apps/admin/.env.example` to `apps/admin/.env`:

| Variable           | Default                 | Purpose                                                                               |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------- |
| `COMMERCE_API_URL` | `http://localhost:8080` | Base URL of the commerce API                                                          |
| `ADMIN_ORIGIN`     | request origin          | Admin public origin, sent as `Origin`; must be a trusted origin on the API (else 403) |

E2E tests use a stub of the `/auth` endpoints, so they need no running backend.

## Scripts (run from the repo root)

| Script                       | What it does                                      |
| ---------------------------- | ------------------------------------------------- |
| `npm run check`              | `tsc` / `svelte-check` in every workspace         |
| `npm run lint`               | Prettier check + ESLint                           |
| `npm run format`             | Prettier write                                    |
| `npm run test:unit -- --run` | Vitest once (bare `test:unit` starts watch mode)  |
| `npm run test:e2e`           | Playwright against a production build of each app |
| `npm run build`              | Build every app                                   |
| `npm run provision:service`  | Mint `SERVICE:fionas-web` credentials (see above) |
