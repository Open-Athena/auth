# `keyParam` is only partly configurable

Found by `jobs` on 2026-11-15 (dist `f4360a7`), when Ryan asked whether share links could use a shorter `?k=`.

## Today

`createGate({ keyParam })` (default `key`) is honored by `handleKeyParam` and `withoutKey`, but other places hardcode `key`:

- `gate.ts` `authenticate`: `url.searchParams.has('key')` / `.get('key')` (around line 399), so a `?k=` request is treated as having no presented key (a bot preview isn't recognized, the "link isn't active" path differs).
- `gate.ts` `unauthenticated`: `searchParams.has('key')` (around line 492) decides whether to clear cookies.
- `client/api.ts` `shareKey` and `shareUrl` always write `key`, so the mint UI builds `?key=` links whatever the server expects.
- `CLEAR_KEY` docs and `/exchange` assume `key`.

## Ask

- One source of truth: every read of the param goes through `keyParam`; `shareKey(token, param?)` / `shareUrl(token, target, param?)` take it (and `GrantsPanel` passes it through, or a `keyParam` prop).
- Optionally accept a list (`keyParam: ['k', 'key']`): the first is what new links use, all are accepted, so an app can shorten its links without breaking ones already sent.
- No change to the default (`key`): self-describing, and a 32-char token dominates the URL's length anyway.

## What `jobs` will do after this lands

Nothing unless Ryan wants `k`; the default stays `key`.

## Done

- `createGate({ keyParam })` takes a string or a list. Every server read goes through `gate.presentedKey(url)`, which returns the first accepted name present. Those reads are `authenticate`, the 401's cookie handling (`unauthenticated`), `handleKeyParam`, and the "keep this link's key" route's pasted-link parsing. `withoutKey` strips every accepted name.
- `gate.keyParam` is the first name, the one new links use. `gate.keyParams` lists them all.
- Client:
  - `shareKey(token, param = 'key')` and `shareUrl(token, target?, param = 'key')`.
  - `exchangeKeyParam`/`hasKeyParam` `param` also takes a list.
  - `keyParam` is a prop on `GrantLink`, `GrantCard` and `GrantsPanel`; it sets "Copy key" and the `Key:` line in "Copy all".
  - `buildLink` is the app's, so it passes the param to `shareUrl` itself.
- `CLEAR_KEY` docs say it works under any accepted name. `/exchange` takes the token in its body, so it has no param to configure.
- The default is still `key`.
- Tests: `test/key-param.test.ts` (gate); `test/client.test.ts` and `test/client-helpers.test.ts` (client helpers).
