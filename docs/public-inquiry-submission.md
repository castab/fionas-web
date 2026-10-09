# Public inquiry submission

The web app owns Fiona's menu, input descriptors, availability, selection limits and pricing formulas in TypeScript. Only monetary values are private configuration. Every accepted request is published as an **InquirySubmitted v1** event to NATS JetStream. The contract is [asyncapi.yaml](../asyncapi.yaml): subject `fionas.inquiries.submitted.v1`, stream `FIONAS_INQUIRIES`. The public site calls no backend API. fionas-commerce and any other application consume the event from the stream.

## Local and deployment setup

Set BOOKING_ENABLED=true and NATS_URL in the public app's private environment. For authentication, set either NATS_CREDS_FILE (an absolute path to a `.creds` file, preferred in production) or NATS_USER and NATS_PASSWORD. Booking stays gated with a 404 while disabled, and the marketing site starts without NATS. The connection opens lazily when /book first loads, reconnects on its own and drains on shutdown. Its URL, user, password and creds path are never logged or sent to the browser.

While NATS is unconfigured, unreachable or reconnecting, /book shows its "request form isn't available right now" card instead of a form the customer couldn't send. The page load waits at most 1.5 s for a connection. The web user can't inspect streams, so a missing stream or a denied publish still surfaces only on submission. The server logs connection changes as `[nats] Connected`, `Disconnected; reconnecting`, `Reconnected`, `Connection closed`, and server errors, naming only what happened. A failure to connect, or a missing NATS_URL, is logged once per outage rather than on every page view.

Locally, `npm run nats:up` starts NATS + JetStream from compose.yaml (Docker) and creates the stream. apps/public/.env.example already points at it as the dev-only `fionas-web` user. In any other environment, create or verify the stream once with `npm run nats:setup -- --server <url> --creds <admin.creds> [--replicas 3] [--max-age 0|90d…]`. It refuses to change an existing stream that differs unless `--update` is given.

Set FIONAS_PRICES_FILE to an absolute private YAML path, e.g. /run/secrets/fionas/prices.yaml. Local development can use a gitignored prices.local.yaml. Never commit or bake the business price book into an image. The test fixture apps/public/e2e/fixtures/prices.synthetic.yaml is deliberately fictional and is never a runtime default. It can be copied to an ignored local file and replaced with operator-supplied prices.

The supported YAML subset is intentionally small: revision is a nonempty quoted string (at most 160 characters), followed by amounts, a mapping with two-space indentation. Every amount is a quoted nonnegative exact decimal string. No duplicate keys, extra keys, YAML numbers, aliases, tags, merges, exponents or constructors are accepted. The exact required keys are exported as PRICE_KEYS in apps/public/src/lib/server/menu.ts and listed below. Each key must exist, including explicit zero-valued surcharges:

- event.base
- event.per_guest
- topping.extra_per_guest
- hand-scooped-flavor.hand-scooped-chocolate-chip
- hand-scooped-flavor.hand-scooped-chocolate
- hand-scooped-flavor.hand-scooped-mint-chip
- hand-scooped-flavor.hand-scooped-butter-pecan
- hand-scooped-flavor.hand-scooped-vanilla-bean
- hand-scooped-flavor.hand-scooped-strawberry
- hand-scooped-flavor.hand-scooped-cheesecake
- topping.rainbow-sprinkles
- topping.chocolate-sauce
- topping.caramel-sauce
- topping.crushed-oreo
- topping.whipped-cream
- topping.sliced-almonds
- topping.maraschino-cherries
- topping.gummy-bears
- topping.marshmallow-sauce
- cone-option.cup
- cone-option.sugar-cone
- cone-option.cake-cone

Nine integer digits and twelve fractional digits bound input. The public menu offers any integer guest count, so every amount must settle to whole cents. There is no service duration and no hourly rate; an `event.hourly` key is rejected as unknown. The engine rejects nonsettleable extensions without rounding. Precise rates for restricted quantities remain supported by the exact line arithmetic and staff editor. Currency is code-owned USD; line tax is zero because no existing tax policy is configured.

Set FIONAS_REPLAY_SECRET to an independent cryptographically random signing secret of at least 32 bytes. Generate it with Node crypto.randomBytes(32).toString('base64url') in your private deployment environment. Never reuse a key or password from another system. All public replicas must share this secret throughout the 24-hour replay window. Rotating it immediately invalidates outstanding envelopes; retain it across normal deployments and restarts. Replays then remain independent of the current price file. Neither secret, price-file path nor price keys are projected to visitors.

## Pricing and freshness

The file is validated and cached as one immutable snapshot after the first successful read in each process. Missing or invalid configuration produces a safe unavailable state. There are no watchers, fallbacks, polling or admin configuration editors. Changing a file requires restarting every replica. Change the opaque revision whenever amounts or public menu/rules change; unchanged-revision changes cannot be detected across restarts, so operators must enforce this contract. Coordinate replicas on the same revision. A stale initial form is refused locally before anything is published, receives the current projected prices and a fresh submission key, and requires customer review.

The public projection contains only control metadata and applicable advisory rates. It may reveal customer-facing prices; the privacy requirement concerns version control, not customer secrecy. The base-service line is the flat event.base. Further lines charge event.per_guest per guest, any nonzero per-guest add-on for a selected item, and topping.extra_per_guest per guest for each topping beyond the four included. Neither the inquiry nor its lines carry a service duration. Decimal arithmetic uses BigInt without truncating rates. Form controls ask an estimated guest count (a stepper starting at 50, 1–300 online; larger events are refused with a request to describe them in the note), exactly four of Chocolate Chip/Chocolate/Mint Chip/Butter Pecan/Vanilla Bean/Strawberry/Cheesecake hand-scooped flavors, four to six toppings (Rainbow Sprinkles, Chocolate Sauce, Caramel Sauce, Crushed Oreo, Whipped Cream, Sliced Almonds, Maraschino Cherries, Gummy Bears, Marshmallow Sauce), and at least one of Cups/Sugar Cones/Cake Cones in any combination at no extra charge. Soft serve is not offered until a machine is sourced. Cheesecake and Marshmallow Sauce remain visible and unavailable (Coming soon). Allergen notes (Butter Pecan: tree nuts; Crushed Oreo: wheat & soy; Sliced Almonds: tree nuts) are code-owned info popovers. The server enforces the same 300-guest online limit before any delivery.

The browser submits customer answers and an opaque priceRevision, never trusted financial lines. prepareInquiry validates the complete configured service. The server independently uses its own projection and private snapshot to price and construct requestedService with code-owned labels. The event's `data` contains name/email/ZIP/date/type, the optional message, requestedService, the priceRevision and ordered PricedLine records. It sends no totals. The event also carries an `id` (a UUID that consumers deduplicate on), `occurredAt`, `schemaVersion: 1`, `type` and `source`; all are fixed once, when the server prices the request. A published inquiry neither books a date nor takes payment. What consumers do with it (for example, commerce creating an Estimate) is up to them.

## Immutable delivery and replay

Every logical submission owns one key, published as `Nats-Msg-Id`. The stream drops a repeated ID inside its 24-hour duplicate window, which equals the replay window. A delivery is complete only when JetStream's PubAck arrives, which means the event is stored. Each publish expects the stream `FIONAS_INQUIRIES`; the client sends that expectation as the `Nats-Expected-Stream` header, which is stored with the message.

Outcomes:

- **Unavailable** (definitely not stored): NATS is not configured or reachable, the connection is closed or draining, no stream captures the subject ("no responders"), the server denies this user's publish, or the stream refuses the message (for example, a different stream captures the subject). Visitors see "unavailable" with editable answers. The server log names only the error kind.
- **Unknown** (may have been stored): no PubAck in time, a connection dropped after sending, or anything unexpected. After a 250 ms pause, the server retries once with identical bytes and the same `Nats-Msg-Id`. If the first attempt was stored, the retry is acknowledged as a duplicate and counts as received. If the outcome is still unknown, the answers freeze. There is no auto-resubmission.
- **Key reused:** if the very first delivery of a newly built command is acknowledged as a duplicate, the key already belongs to an earlier submission, and nothing new was stored. This requires a deliberate restart with a new key. A replay or a retry is different: its bytes are identical by construction, so a duplicate means success.

Before the first delivery, the server builds the event and signs an envelope with HMAC-SHA256. The envelope holds the serialized event, its SHA-256 digest, the logical key and the issue time (envelope version 2). Replay verification checks, before anything is published:

- the signature, in constant time,
- the key and the digest,
- the event's structure (the AsyncAPI schema's rules, plus every line settling to whole cents),
- a 24-hour lifetime.

Altered, unsigned, expired, re-bound and version 1 (pre-NATS) envelopes are refused with no fallback. A valid old envelope republishes its original event (same `id`, same `occurredAt`, same lines) even after prices change; it is never repriced. The browser holds customer data in that envelope only for this workflow. The envelope is not confidential encryption, and it is never logged.

The page is private/no-store because it carries a unique token. A successful delivery uses an HttpOnly receipt cookie and a 303 to /book/received. The receipt is the event's `id` and `occurredAt`. Native and enhanced forms share the same server action. NATS settings and credentials never reach client code.

## NATS permissions

The public site's NATS user needs exactly two permissions:

- publish to `fionas.inquiries.submitted.v1`;
- subscribe to `_INBOX.>`, where JetStream sends the PubAck.

It needs no JetStream API access: it cannot read, create or change streams. infra/nats/nats-server.conf shows this for local development. In production, use the operator/account (JWT) model, for example with nsc:

```
nsc add user --name fionas-web --allow-pub fionas.inquiries.submitted.v1 --allow-sub '_INBOX.>'
nsc generate creds --name fionas-web > fionas-web.creds   # mount it and set NATS_CREDS_FILE
```

Give stream administration (`npm run nats:setup`) and each consumer their own users. Consumers read with durable consumers on `FIONAS_INQUIRIES`, deduplicate on the event `id`, and follow the versioning policy in asyncapi.yaml. Nothing in this repository changes deployed streams, users, price files or databases on its own; run `nats:setup` deliberately against each environment.
