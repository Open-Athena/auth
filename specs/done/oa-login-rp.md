# `@open-athena/auth/oa-login`: sign in through login.oa.dev, with Google kept for everyone else

From the `transcripts` session (`~/c/oa/transcripts`), 2026-11-17.

## Why

Three apps sign in through the broker today, each with its own code:

- **disky** (`~/c/disky/packages/pages-kit/src/oa.ts`, spec `~/c/disky/specs/oa-login-rp.md`) has the complete pattern: "Sign in with OA" beside "Sign in with Google", one silent `prompt=none` attempt before the wall, a sign-out that sticks, PR-preview clients, and a remembered account.
- **jobs** (`~/c/oa/jobs/worker/index.ts`) and **applitrack** (`~/c/oa/applitrack/cloudflare/lib/auth.ts`) use the broker alone, with hand-built provider config.

transcripts.oa.dev is next (client `oa-transcripts`, registered 2026-11-17). Its outside guests sign in with Google directly, which the broker can't serve (it admits only `openathena.ai`). Rather than a fourth copy, disky's module moves here, and the apps adopt it.

## What

A new entry point, `@open-athena/auth/oa-login` (`src/adapters/oa-login.ts`): disky's `pages-kit/src/oa.ts`, with the same export names so disky's adoption is a change of import. Nothing in it is Pages-specific: every function takes a `Request` and returns a `Response`, so a Worker uses it the same way.

Changes from disky's version:

- **Paths are options.** `OaLoginHost` / the config take `startPath` (default `/auth/oa`), `callbackPath` (`/auth/oa/callback`), and `signInPath` (`/signin`, where an explicit failure lands with `?error=oa:<reason>`). An app whose sign-in page is the wall on every path, like transcripts, passes its own.
- **`home`** (default `/`): where a failed silent exchange lands (`<home>?sso=error`).
- Everything else as disky built it: `oaLoginOptions`, `oaStart`, `oaCallback`, `silentAttempt` (+ `SilentApp`), `markedSignedOut`, `resumed`, `clearedOnSignIn`, `attemptInFlight`, `rememberAccount`, `rememberedAccount`, `hintedAccounts`, the cookie names and TTLs.

The README gets a section on adopting it, with the two-button wall and where each hook goes (middleware: `silentAttempt`; logout: `markedSignedOut`; every response: `clearedOnSignIn`).

## Tests

disky's cases for the module, without its app wiring: config gating (any of issuer, client id, secret unset → `null`, 404), the start's authorize URL (PKCE S256, nonce, no `hd`), the callback's error mapping (explicit vs silent), the remembered account, and `silentAttempt`'s decisions (navigation headers, `notWalled`, own-way params, the skip cookie, `//host`, the attempt redirect and its cookie), `markedSignedOut`, `resumed`, `clearedOnSignIn`, and the path options.

## Downstream

- **transcripts** adopts it once a dist build has it (its spec: `~/c/oa/transcripts/specs/sharing-controls.md`, and the SSO commit there).
- **disky** and **jobs** can switch when convenient; tell their sessions.

## As built

`src/adapters/oa-login.ts`, exported as `@open-athena/auth/oa-login`; tests in `test/oa-login.test.ts` (17); README "An App Signing In Through login.oa.dev"; `scripts/verify-dist.mjs` checks the entry point. The path options are `startPath` (on `SilentApp`), `callbackPath`, `signInPath` and `home` (on `OaLoginHost`). Beyond those, the code is disky's.
