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

| Variable            | Default                 | Purpose                                                                                                                                                                                        |
| ------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMMERCE_API_URL`  | `http://localhost:8080` | Base URL of the commerce API                                                                                                                                                                   |
| `FIONAS_UI_API_KEY` | unset                   | Trusted UI key (same name and value as the backend's), sent as `Authorization: Bearer <key>` on the three endpoints above; without it they return 401 and `/book` shows its "unavailable" page |
| `BOOKING_ENABLED`   | unset (off)             | `true` enables `/book` and links the Book buttons to it; off: `/book` is a 404 and the buttons show the toast                                                                                  |

`FIONAS_UI_API_KEY` is a secret: keep it only in the git-ignored `apps/public/.env` (or your host's
environment), never in `.env.example`, and never in client code. It is read through SvelteKit's
private env in `src/lib/server/`, so it cannot be bundled into the browser.

While `BOOKING_ENABLED` is off, `/book` (page, form action and estimate endpoint) returns 404. E2E tests use a stub API, so they need no running backend.

Every inquiry is a request for configured ice cream service: the form won't send until guest
count, duration and the required flavor/topping/cone choices are complete, and the backend prices
each accepted inquiry into its initial Estimate. The estimate shown while filling in is advisory.

Each rendered form carries one non-secret submission token, which the server sends as
`POST /inquiries`' `Idempotency-Key` for every delivery and retry of that submission, so double
clicks, lost responses and retries never create duplicate inquiries. A changed catalog
(`CATALOG_REVISION_STALE`) refreshes the form for the customer to review; nothing is resubmitted for
them. See [docs/public-inquiry-submission.md](docs/public-inquiry-submission.md).

## Admin console

`apps/admin` is the staff console (`admin.fionasicecream.com` / `admin-dev.fionasicecream.com`). Staff sign in with
their commerce API account; the admin server logs in on their behalf and keeps the session cookie on the admin
host. **All backend calls go through the SvelteKit server**; see [docs/admin-architecture.md](docs/admin-architecture.md).
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
