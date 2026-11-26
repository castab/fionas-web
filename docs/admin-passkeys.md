# Admin passkeys and Account settings

Staff can sign in to the admin with a **passkey** (WebAuthn) as well as their password, and manage
their passkeys and password on **Account settings** (`/settings/account`). Commerce owns identity:
the passkeys, the ceremonies and their verification, sessions and the ten-minute "sudo" window
(fionas-commerce, `passkey/` package). The admin owns the browser side and the same-origin endpoints
in front of commerce. Passwords stay as the fallback: there are no passkey-only accounts, and
recovery from lost passkeys is the password (or an administrator's password reset).

## Flow

```
 Login page / Account settings / (app) shell nudge
      │  same-origin JSON only (/login/passkey*, /settings/account/*)
      ▼
 +server.ts ─▶ $lib/server/passkeys.ts ─▶ request() ─▶ commerce /auth/passkey*, /staff/passkeys*
               $lib/server/account.ts                 /staff/account, /staff/credentials/password
               (whitelist credential fields,          (trusted Origin; staff cookie on /staff/*)
                ceremony id in an HttpOnly cookie,
                map errors to our copy)
```

The browser uses `@simplewebauthn/browser` (`$lib/passkey-client.ts`) only for the WebAuthn calls,
base64url/JSON conversion, conditional UI and aborting a pending ceremony. Everything is
feature-detected: without WebAuthn there is no passkey button, no nudge, and Account settings says
the browser can't use passkeys.

## Commerce contract (what the admin sends and reads)

The source of truth is fionas-commerce `http/StaffAccountRoutes.kt` (and its README, "Staff
passkeys"); `e2e/passkey-stub.mjs` mirrors it. WebAuthn binary fields are base64url (no padding):
the standard `PublicKeyCredential*OptionsJSON` and `toJSON()` credentials. Errors are the usual
`{code, message}` envelope; the admin reads only `status` and `code`.

| Route                                       | Access                       | Request → success                                                               | Failures the admin maps                                                                                    |
| ------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `POST /auth/passkey/options`                | public, rate-limited, Origin | → `{ceremonyId, publicKey}` (`allowCredentials: []`, UV required)               | 429, 503 `passkeys_disabled`                                                                               |
| `POST /auth/passkey`                        | public, rate-limited, Origin | `{ceremonyId, credential}` → 204 + session cookie                               | 404 `not_found` (passkey not registered), 401 `unauthenticated` (anything else), 429, 503                  |
| `GET /staff/account`                        | staff USER                   | → `{authenticatedAt, recentAuthenticationUntil, passkeysEnabled, passkeyCount}` | —                                                                                                          |
| `GET /staff/passkeys`                       | staff USER                   | → `{rpId, userHandle?, passkeys: [Passkey]}` (never public keys)                | 503                                                                                                        |
| `POST /staff/passkeys/registration/options` | staff USER + recent auth     | → `{ceremonyId, publicKey}`                                                     | 403 `reauthentication_required`, 409 `conflict` (20 passkeys), 503                                         |
| `POST /staff/passkeys`                      | staff USER + ceremony        | `{ceremonyId, credential, name?}` → 201 `Passkey`                               | 409 `conflict` (limit or already registered), 422 (not verified, expired, not discoverable, bad name), 503 |
| `PATCH /staff/passkeys/{id}`                | staff USER                   | `{name: string}` (required; blank clears it) → 200 `Passkey`                    | 404 (unknown or someone else's), 422 (too long, control characters), 503                                   |
| `DELETE /staff/passkeys/{id}`               | staff USER + recent auth     | → 200 `{rpId, userHandle?, passkeys}` (the remaining ones)                      | 403 `reauthentication_required`, 404, 503                                                                  |
| `PUT /staff/credentials/password`           | staff USER, rate-limited     | `{currentPassword, newPassword}` → 204 + fresh session cookie                   | 403 `current_password_incorrect`, 422 (under 12, over 256, or unchanged), 429; 401 = session ended         |

`Passkey` is `{id, name?, credentialId, aaguid, backupEligible, backedUp, transports, createdAt,
lastUsedAt?}`: optional fields are omitted, and an unreported AAGUID is all zeros. `GET
/staff/account` carries sign-in state only; who the person is comes from `/auth/me`
(`locals.user`). Ceremonies are single-use, five minutes, and spent even when verification fails.
Every sign-in (password or passkey) revokes the session cookie the request presented, whoever it
belonged to. Passkey ceremonies have their own rate limit (burst 30, one refill every ten
seconds), separate from password login.

When a deployment has passkeys off, every `/auth/passkey*` and `/staff/passkeys*` route answers 503
`passkeys_disabled` and `/staff/account` says `passkeysEnabled: false`; password sign-in, password
change and the account read keep working.

## Ceremonies and cookies

- The **ceremony id never reaches the browser.** `…/options` endpoints keep it in the admin-local
  cookie `__Host-fionas_webauthn` (HttpOnly, Secure, SameSite=Strict, Max-Age 300, Path=/) and
  return only `{publicKey}`. The finish endpoint reads and deletes it (one finish per ceremony).
- `forwardedCookie` (`$lib/server/backend.ts`) strips `__Host-fionas_webauthn` and
  `__Host-fionas_passkey_nudge`; commerce receives the staff session and nothing else of ours.
- Credential JSON from the browser is copied field by field (`parseAuthenticationCredential`,
  `parseRegistrationCredential`) with base64url and size checks; unknown fields and client extension
  results other than `credProps.rk` are dropped. (Commerce ignores the extra registration fields
  the browser reports, such as `publicKey` and `publicKeyAlgorithm`; it parses the attestation.) Options from commerce are projected the same way,
  and registration always asks for `attestation: none`.
- Options requests run one at a time in the browser, so the newest ceremony cookie always belongs
  to the newest request (autofill vs. the passkey button).
- All these endpoints accept only `application/json` and answer `no-store`.

## Sign-in page

- The User field is `autocomplete="username webauthn"`. When `isConditionalMediationAvailable()`,
  the page starts a conditional request on mount, so passkeys appear in the autofill suggestions.
  Autofill is quiet: an options failure or a browser error shows nothing (the person didn't do
  anything); only a failed finish (for example an unknown passkey) is shown.
- **Sign in with a passkey** (secondary button, JavaScript only) cancels the conditional request,
  starts a modal one, and restarts autofill when it ends.
- Copy (`passkeyFailure`, `ceremonyErrorMessage` in `$lib/passkeys.ts`): a cancel
  (`NotAllowedError`/`AbortError`) is silent; commerce's 404 at sign-in (our code `passkey_unknown`)
  says "That passkey isn't set up for this account anymore" and calls
  `PublicKeyCredential.signalUnknownCredential` when available; 429
  reuses the Retry-After copy from `$lib/login.ts`; anything else is our own generic copy, never
  commerce's text.
- On success the server re-issues commerce's session cookie (`applySetCookies`) and the page
  `goto('/')`s.
- Passkeys off (503 `passkeys_disabled` from the options call, autofill's or the button's): the
  page hides the button and stops conditional mediation, without an error.

Each visit to `/login` with WebAuthn support asks commerce for an authentication challenge. Commerce
rate-limits passkey ceremonies separately from password login, so page views never spend password
attempts.

## Passkey nudge after a password sign-in

The password sign-in action sets `__Host-fionas_passkey_nudge` (HttpOnly, Secure, SameSite=Lax,
two minutes). The next `(app)` layout load takes it, reads `GET /staff/account`, and asks the shell
to show the nudge only when `passkeysEnabled` and `passkeyCount === 0`. A passkey sign-in never
sets it.

1. When `getClientCapabilities().conditionalCreate` is supported, the shell first tries an
   **automatic passkey upgrade** (`create()` with `mediation: 'conditional'`): the password manager
   just used may create a passkey silently. Success shows a toast.
2. Otherwise — or when that fails, or hasn't answered within three seconds — it shows "Sign in
   faster with a passkey — use your fingerprint, face, or screen lock" with **Create a passkey** and
   **Not now**. Creating from the prompt cancels a still-pending silent request.
3. "Not now" is remembered on this device for 30 days (`localStorage`
   `fionas.passkeyNudge.dismissedUntil`). A dismissal also skips the silent upgrade.

The session is brand new at this point, so commerce's sudo check passes without a confirmation.

## Account settings (`/settings/account`)

Layout follows Notifications (`max-w-[760px]`, flat cards, `no-store`, its own `<title>`). The
account menu's **Account settings** item (desktop sidebar and mobile menu) links here with
`aria-current="page"`.

- **Profile**: name, username and role from `/auth/me` (the layout's `user`), read-only.
- With passkeys off (`passkeysEnabled: false`, or 503 `passkeys_disabled` from the list), the
  passkey section is left out entirely, without an error.
- **Passkeys**: each row shows a provider icon and name from the AAGUID (`$lib/passkey-providers.ts`),
  the staff member's own name for it, "Created …", "Last used …" (or "Not used yet"), and a
  **Synced** badge when backed up. **Rename** edits inline (1–64 characters; blank sends `""`,
  which clears the name). **Remove** opens a confirmation dialog that warns when it's the last
  passkey ("You'll sign in with your password"); commerce answers the remaining passkeys, which
  feed `signalAllAcceptedCredentials` (feature-detected, with the list's `rpId`) so password
  managers hide the removed one. **Create a passkey** is disabled at the limit of 20; a 409 reads
  as the limit when starting and as "already on your account, or you've reached 20 passkeys" when
  finishing. The empty state says what a passkey is in two sentences. The word is always lowercase
  "passkey".
- **Password**: current / new / confirm (`autocomplete="current-password"` / `"new-password"`, plus
  a hidden `username` field for password managers) as a form action (`?/password`) that works
  without JavaScript. The requirement (12–256 characters, different from the current one) is shown
  up front and checked locally (`passwordChangeProblem`) before commerce applies its own policy.
  403 `current_password_incorrect` says "Your current password isn't right" on that field; a 401
  means the session ended. On success commerce signs out every other session and issues a fresh
  one; the page says "Other devices were signed out." Passwords are never echoed back into the
  form.

### "Confirm it's you" (sudo)

Creating or removing a passkey needs a sign-in within the last ten minutes. When commerce answers
403 `reauthentication_required`, the page opens a dialog offering **Use a passkey** (a modal
assertion through `/login/passkey`, shown when the account has passkeys) or the password with the
username prefilled (`POST /settings/account/reauthenticate`, which signs in as `locals.user` — never
a username from the browser). Both forward the current session cookie, so commerce revokes it as it
issues the new one, and the original action is retried automatically.

A passkey re-authentication must stay the same person: if `/auth/passkey` returns a session for a
different account, the server signs that new session out again and answers 409
`different_account`. Commerce has already revoked the presented session by then, so the person is
signed out and is told to sign in again; a re-authentication never switches accounts. Some browsers allow only one passkey prompt per click; if the retried
create is refused after a passkey confirmation, the page asks the person to choose **Create a
passkey** again.

## Provider names (AAGUIDs)

`$lib/passkey-providers.ts` maps AAGUIDs to provider names and a kind (password manager, platform,
security key), curated from the community `passkey-authenticator-aaguids` list
(github.com/passkeydeveloper). Only names are bundled, no logos; the icon is a generic glyph per
kind. All-zero and unknown AAGUIDs read as "Passkey". That list is being retired upstream (its JSON
files empty in January 2027), so update the map by hand when a common provider is missing.

## Hooks

- `/login/passkey` and `/login/passkey/options` are public (`PUBLIC_ROUTES`) but still resolve
  `/auth/me`, because a signed-in caller is re-authenticating.
- `JSON_ROUTES` (formerly `PUSH_JSON_ROUTES`) lists every same-origin JSON endpoint that answers a
  signed-out caller with `401 {"code":"unauthenticated"}` (`no-store`) instead of `303 /login`: the
  five push routes plus `/settings/account/passkeys`, `…/passkeys/options`,
  `…/passkeys/[passkeyId]` and `…/reauthenticate`. The Account settings page itself keeps the
  redirect.
- `/login*` and `/settings/account*` responses are `no-store`.

## Tests

- Vitest: `$lib/passkeys.test.ts` (readers, copy, password checks, nudge dismissal, provider map),
  `$lib/server/passkeys.test.ts` and `account.test.ts` (fake `fetch`: paths, bodies, cookies,
  whitelisting, the ceremony cookie, same-person re-authentication), `backend.test.ts` (cookie
  stripping).
- Playwright `e2e/passkeys.e2e.ts` runs on both projects with a Chromium CDP **virtual
  authenticator** (ctap2, internal, resident keys, UV). WebAuthn rejects IP addresses as RP IDs, so
  these specs use a second admin server on `http://localhost:4175` started from the same build
  (`playwright.config.ts`); the stub trusts that origin too. The stub verifies challenges, origin,
  rpIdHash, UP/UV flags, counters and ES256/Ed25519/RS256 signatures with the key captured at
  registration, and keeps accounts per `passkey-…` username so parallel tests never share passkeys.
  The older fixture users (`brayan`, `dashboard-*`, `request-*`) read an account with passkeys
  off, so their specs never see the nudge. Test hooks: `POST /__test/account` `{sudoExpired: true}`
  ages the session past ten minutes, `{forgetPasskeys: true}` drops the account's passkeys (for the
  unknown-passkey 404), `{passkeysDisabled: true}` switches passkeys off for that account. The
  sign-in page's disabled case intercepts `/login/passkey/options` with `page.route`.
- The virtual authenticator answers a conditional (autofill) request immediately and leaves a
  conditional create pending, so specs turn autofill off unless they test it, and the automatic
  upgrade is covered only for its fallback (the prompt still appears).
