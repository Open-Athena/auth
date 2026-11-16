# `handleKeyParam` / `dropKey`: protocol-relative redirect leaves the site

Found by `jobs` on 2026-11-15 while adopting dist `ac40c22` (`691b15b`), by its existing test `no path redirects off-site`.

## Repro

`GET //evil.example/x?key=<valid token>` → `gate.handleKeyParam(req)` → `dropKey` → `302 Location: //evil.example/x`. Browsers read `//host/…` as protocol-relative: an open redirect off the app's origin, with the session cookie set. Same for `/\evil.example/x` (browsers treat `\` as `/`). `?key=-` and the staff-click redirect share `dropKey`/`withoutKey`, so they're affected too.

`jobs`'s old inline redeem block collapsed leading slashes (`path.replace(/^\/+/, '/')`, and lower-cases/normalizes `\` before that); `jobs` now rewrites `handleKeyParam`'s `Location` the same way as a stopgap (`worker/index.ts`).

## Ask

- In `dropKey` (and anything else building a `Location` from the request path): collapse leading `/` and `\` runs to a single `/` before emitting, so the redirect is always same-origin.
- A test per entry point (`redeem` ok, `staff`, `cleared`, `?as=recipient` strip) with paths `//evil.example/x` and `/\evil.example/x`, asserting `Location` starts with exactly one `/` and no `//`.

## What `jobs` will do after this lands

Drop its `Location` rewrite; bump the dist.

## Done

- `dropKey` (`src/core/gate.ts`) collapses a leading run of `/` and `\` to one `/`. Every `handleKeyParam` redirect goes through it: redeem, staff, `?key=-`, and `?as=recipient`. No other `Location` is built from the request path: email-code `next`s already go through `safeNext`.
- `test/staff-clicks.test.ts` covers all four redirects for both paths, `//evil.example/x` and `/\evil.example/x`. Each must land exactly on `/evil.example/x`. The test failed with `//evil.example/x` before the fix.
