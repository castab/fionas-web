# fionas-web

Websites for **Fiona's Ice Cream**, a towable ice cream trailer serving Fresno & the Madera Ranchos
([@fionasicecream](https://www.instagram.com/fionasicecream/)).

npm-workspaces monorepo:

```
fionas-web/
├── apps/
│   ├── public/          # marketing site (SvelteKit): landing page and the /book request form
│   └── admin/           # staff console (SvelteKit): dashboard, requests, quotes, payments
├── packages/
│   ├── ui/              # @fionas/ui — Svelte 5 components (Button, Badge, Card, Wordmark, toast…)
│   ├── design-tokens/   # @fionas/design-tokens — brand CSS tokens + Tailwind v4 theme
│   └── shared/          # @fionas/shared — framework-agnostic site details, copy, inquiry form logic
├── scripts/             # operator tools (.mjs): NATS stream setup/tail, AsyncAPI validation
├── infra/nats/          # local NATS server config (dev-only users)
├── asyncapi.yaml        # the versioned contract for the events the websites publish
├── compose.yaml         # local NATS + JetStream
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
npm run nats:up      # local NATS + JetStream for /book (needs Docker)
```

## Booking form & events

The public app owns the menu, form and rules in code. Server pricing reads only private monetary values from FIONAS_PRICES_FILE (a path) or FIONAS_PRICES_YML (the inline YAML, which takes precedence), and FIONAS_REPLAY_SECRET protects immutable retries. Every accepted /book request is published as a versioned **InquirySubmitted** event to NATS JetStream; the public site never calls a backend API. Other applications (fionas-commerce among them) consume the event. Missing or invalid prices or replay secret make /book show an unavailable page. While NATS is unconfigured, unreachable or reconnecting, /book shows that same unavailable card, so customers never fill in a form that can't be sent. The server logs NATS connection changes as `[nats] …`. See [public submission and deployment setup](docs/public-inquiry-submission.md) for required keys, price rotation, synthetic local setup, replica coordination and NATS permissions.

## Events & local NATS

The event contract is [`asyncapi.yaml`](asyncapi.yaml) ([AsyncAPI 3.1.0](https://www.asyncapi.com/docs/reference/specification/v3.1.0)): subject `fionas.inquiries.submitted.v1`, stream `FIONAS_INQUIRIES`, payload schema, headers and an example.

- **Versioning.** The major version is in the subject and in the payload's `schemaVersion`. A breaking change gets a new subject (`.v2`) and a new message in the document; adding an optional field bumps `info.version`'s minor. Consumers ignore fields they don't know and deduplicate on the payload `id`.
- **Contract checks.** `npm run asyncapi:validate` validates the document and its examples. Unit tests check that what the server publishes matches the schema.

[`compose.yaml`](compose.yaml) runs NATS with JetStream for local development. It is configured by [`infra/nats/nats-server.conf`](infra/nats/nats-server.conf), which has dev-only users: `fionas-admin`, and `fionas-web`, which may only publish the inquiry subject. The scripts are plain Node (`.mjs`), so they work the same on Windows, macOS and Linux:

```bash
npm run nats:up      # start NATS (Docker) and create or verify the stream
npm run nats:tail    # print inquiry events as /book publishes them; prompts for URL and token (add -- --all for history)
npm run nats:setup   # create or verify the stream on any server (-- --help for options)
npm run nats:purge   # delete every event in the stream (asks twice; terminal only)
npm run nats:down    # stop NATS (data stays in the nats-data volume)
```

Run `npm run nats:setup` in a terminal to choose the target: press Enter for the local Docker instance, or enter a remote NATS URL (comma-separated URLs for a cluster). The next prompt asks for a preshared token with input hidden. For local Docker, press Enter again to use its dev-only admin credentials. The token is kept in memory for this run and is never saved. `nats:up` always sets up local Docker without prompts.

`npm run nats:tail` asks the same target and token questions. On a remote target, pressing Enter at the token prompt moves on to a `.creds` file path, then a username and hidden password (Enter again connects without authentication). The credentials need JetStream consumer access to `FIONAS_INQUIRIES`; the public app's publish-only `NATS_*` user can't tail.

For a configured target, use `--server` or `NATS_ADMIN_URL`; the latter becomes the target prompt's default. Supply credentials with `NATS_ADMIN_TOKEN`, `--creds` / `NATS_ADMIN_CREDS`, or `--user` / `--password` / `NATS_ADMIN_USER` / `NATS_ADMIN_PASSWORD` to skip the token prompt. `--token` is also supported by setup and tail, but the hidden prompt or environment avoids putting secrets in shell history. Explicit authentication flags override environment authentication; within either source, a credentials file takes precedence over a token, then username/password. Local dev credentials are only defaulted for the exact local Docker URL.

Use `--non-interactive` to skip prompts in automation; redirected/non-terminal runs also use flags/env without prompting. For example, with `NATS_ADMIN_TOKEN` set privately:

```sh
npm run nats:setup -- --non-interactive --server tls://nats.dev.example:4222
npm run nats:tail -- --non-interactive --server tls://nats.dev.example:4222
```

`npm run nats:purge` deletes all events but keeps the stream and its settings, on local Docker or any server you point it at. It uses the same target and credential prompts as `nats:tail`, then asks twice: a yes/no that states how many events will be lost, and the stream name typed out. Anything else cancels. It only runs in a terminal, and there is no flag to skip the questions. The credentials need permission to purge the stream (stream-management access). A deleted event can't be recovered.

`nats:setup` never silently rewrites an existing stream. It reports any difference and changes nothing unless you pass `--update`. Setup requires credentials with JetStream stream-management access. These operator settings don't configure the public app's separate `NATS_*` connection.

## Admin console

`apps/admin` is the staff console (`admin.fionasicecream.com` / `admin-dev.fionasicecream.com`). Staff sign in with
their commerce API account; the admin server logs in on their behalf and keeps the session cookie on the admin
host. **All backend calls go through the SvelteKit server**; see [docs/admin-architecture.md](docs/admin-architecture.md).
It uses each staff member's own USER session.
`/requests` lists every request with backend-owned filters, search and cursor pagination, and the dashboard's
summary tiles open it; see [docs/admin-requests-index.md](docs/admin-requests-index.md).
Copy `apps/admin/.env.example` to `apps/admin/.env`:

| Variable           | Default                 | Purpose                                                                               |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------- |
| `COMMERCE_API_URL` | `http://localhost:8080` | Base URL of the commerce API                                                          |
| `ADMIN_ORIGIN`     | request origin          | Admin public origin, sent as `Origin`; must be a trusted origin on the API (else 403) |

Admin E2E tests run against a stub of the commerce endpoints the console uses (`apps/admin/e2e/stub-commerce.mjs`),
so they need no running backend.

## Scripts (run from the repo root)

| Script                       | What it does                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `npm run check`              | `tsc` / `svelte-check` in every app and package                                  |
| `npm run lint`               | Prettier check + ESLint                                                          |
| `npm run format`             | Prettier write                                                                   |
| `npm run test:unit -- --run` | Vitest once (bare `test:unit` starts watch mode)                                 |
| `npm run test:e2e`           | Playwright against a production build of each app (public needs Docker for NATS) |
| `npm run build`              | Build every app                                                                  |
| `npm run nats:up` / `down`   | Start / stop the local NATS + JetStream (see "Events & local NATS")              |
| `npm run nats:setup`         | Create or verify the `FIONAS_INQUIRIES` stream                                   |
| `npm run nats:tail`          | Print inquiry events as they are published                                       |
| `npm run nats:purge`         | Delete every event in `FIONAS_INQUIRIES` after two confirmations                 |
| `npm run asyncapi:validate`  | Validate `asyncapi.yaml` and its examples                                        |

The public e2e tests start the compose NATS themselves. To use an already running server
instead of Docker, set `E2E_NATS_URL`; its stream must be set up and its users must match
`infra/nats/nats-server.conf`.
