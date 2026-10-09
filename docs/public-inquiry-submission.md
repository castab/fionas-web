# Public inquiry submission

The web app owns Fiona's menu, input descriptors, availability, selection limits and pricing formulas in TypeScript. Only monetary values are private configuration. Commerce 0.0.23 accepts trusted already-priced lines; its deleted catalog and form APIs are never called.

## Local and deployment setup

Set BOOKING_ENABLED=true, COMMERCE_API_URL, COMMERCE_SERVICE_ID and COMMERCE_SERVICE_CREDENTIAL in the public app's private environment. Booking stays gated with a 404 while disabled; the marketing site starts without these credentials.

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
- topping.mini-marshmallows
- cone-option.cup
- cone-option.sugar-cone
- cone-option.cake-cone

Nine integer digits and twelve fractional digits bound input. The public menu offers any integer guest count, so every amount must settle to whole cents. There is no service duration and no hourly rate; an `event.hourly` key is rejected as unknown. The engine rejects nonsettleable extensions without rounding. Precise rates for restricted quantities remain supported by the exact line arithmetic and staff editor. Currency is code-owned USD; line tax is zero because no existing tax policy is configured.

Set FIONAS_REPLAY_SECRET to an independent cryptographically random signing secret of at least 32 bytes. Generate it with Node crypto.randomBytes(32).toString('base64url') in your private deployment environment. Never use a Commerce signing key. All public replicas must share this secret throughout the 24-hour replay window. Rotating it immediately invalidates outstanding envelopes; retain it across normal deployments and restarts. Replays then remain independent of the current price file. Neither secret, price-file path nor price keys are projected to visitors.

## Pricing and freshness

The file is validated and cached as one immutable snapshot after the first successful read in each process. Missing or invalid configuration produces a safe unavailable state. There are no watchers, fallbacks, polling or admin configuration editors. Changing a file requires restarting every replica. Change the opaque revision whenever amounts or public menu/rules change; unchanged-revision changes cannot be detected across restarts, so operators must enforce this contract. Coordinate replicas on the same revision. A stale initial form is refused locally before any backend POST, receives the current projected prices and a fresh submission key, and requires customer review.

The public projection contains only control metadata and applicable advisory rates. It may reveal customer-facing prices; the privacy requirement concerns version control, not customer secrecy. The base-service line is the flat event.base; additional lines charge guests, selected item add-ons and selected toppings beyond four times guests. Neither the inquiry nor its lines carry a service duration. Decimal arithmetic uses BigInt without truncating rates. Form controls ask an estimated guest count (a stepper starting at 50, 1–300 online; larger events are refused with a request to describe them in the note), exactly four of Chocolate Chip/Chocolate/Mint Chip/Butter Pecan/Vanilla Bean/Strawberry/Cheesecake hand-scooped flavors, four to six toppings (Rainbow Sprinkles, Chocolate Sauce, Caramel Sauce, Crushed Oreo, Whipped Cream, Sliced Almonds, Maraschino Cherries, Gummy Bears, Mini Marshmallows), and at least one of Cups/Sugar Cones/Cake Cones in any combination at no extra charge. Soft serve is not offered until a machine is sourced. Cheesecake and Mini Marshmallows remain visible and unavailable (Coming soon). Allergen notes (Butter Pecan: tree nuts; Crushed Oreo: wheat & soy; Sliced Almonds: tree nuts) are code-owned info popovers. The server enforces the same 300-guest online limit before any delivery.

The browser submits customer answers and an opaque priceRevision, never trusted financial lines. prepareInquiry validates the complete configured service. The server independently uses its own projection and private snapshot to price and construct requestedService with code-owned labels. POST /inquiries contains name/email/ZIP/date/type, optional message, requestedService and ordered PricedLine records. No totals or backend offering references are sent. A successful request creates an Estimate; it neither books a date nor takes payment.

## Immutable delivery and replay

Every logical submission owns one Idempotency-Key. Automatic retry sends the identical priced body once after an unknown outcome. Every 5xx, unreadable response, timeout and uncertain conflict leaves the outcome unknown. Answers freeze after that outcome. A definite receipt or refusal ends it; IDEMPOTENCY_KEY_REUSED requires deliberate restart. There is no auto-resubmission.

Before first delivery the server signs an envelope containing the immutable serialized command, SHA-256 digest, logical key and issue time with HMAC-SHA256. Replay verification checks signature in constant time, key, digest, structural shape and a 24-hour lifetime before any backend call. Altered, unsigned, expired or re-bound commands are refused with no fallback. A valid old envelope resends its original priced body even after prices change; it is never repriced. The browser holds customer data in that envelope only for this workflow; it is not confidential encryption and is never logged.

The page is private/no-store because it carries a unique token. A successful delivery uses an HttpOnly receipt cookie and a 303 to /book/received. Native and enhanced forms share the same server action. SERVICE exchange remains lazy, cached only in memory, refreshed once on 401, with no retry on 403. Credentials and tokens never reach client code.

## Operator permission remediation

fionas.web must grant exactly fionas.inquiries.create. npm run provision:service validates this set and refuses broader existing roles or service assignments; it never silently rewrites a global role. An authorized operator must first inspect every principal using that role, deliberately replace its permissions with only inquiry creation (and remove any other roles from this dedicated service), then rerun provisioning. Review the backend migration guide for database/bootstrap migration separately. This PR does not modify deployed roles, price files or databases.
