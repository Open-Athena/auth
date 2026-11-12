# Session log: lifecycle events, timer gaps, Ray IDs and later-success links

From disky's r2 deployment (`~/c/disky/wt/r2`). r2 shipped these as a local pnpm patch on auth dist `22b5eae` (disky `876069c9`, Nov 9–10). Disky's `cloud` has since dropped local auth patches (`60f691ff`), and r2 took cloud's pin `3b92256` in merge `96db9436`. Until auth has these features, r2 records none of them.

Auth `e5013f6` already records `online`, `visibility` and `visible_ms` on a failed fetch. This spec covers the rest.

## Requested behavior

- **`life` kind**: initial online/visibility hints, prior tab discard where the browser exposes it, online/offline, freeze/resume, pageshow/pagehide (with BFCache `persisted`). A 10-second pulse records scheduling gaps longer than 30 s (`s: 'gap'`, `ms`). These may be throttling, suspension or a busy main thread, not necessarily sleep. The pulse stops when logging stops. Its activity notification defaults off.
- **Per-fetch context**: a page-local request number (`id`); online and visibility at start and end (`on0`/`on`, `vis0`/`vis`); time since the page became visible (`visMs`); the most recent scheduling gap (`gapMs`, `gapAgo`); and the end timestamp (`end`) and wall duration, alongside the existing monotonic `ms`. Visibility is observed at fetch start, so query-library listeners that run first don't leave it stale.
- **Ray ID**: a syntactically valid `cf-ray` response header is kept as `ray`. A rejected fetch has no response and so no Ray ID. No extra request headers and no diagnostic requests.
- **Cancellation evidence**: whether an explicit signal, an AbortError or pagehide supplied it. Never copy abort reasons, cookies, authorization or header collections.
- **Timeline (react model)**: a later successful repeat is linked to a failed request only for an exact, unmasked, same-origin GET/HEAD on the same page that started after the failure ended. A different query, another page load, a masked URL, a write, an earlier concurrent read or a cancelled read doesn't qualify. The original error stays counted. Rendered as "later success after request #N (Xs after failure)".
- **Wire whitelist**: the server's `BUILTIN_FIELDS` accepts only these declared scalar fields, and `life` joins the kinds.

## Reference implementation

r2's source patch targets auth `22b5eae` and does not apply to `b9fc7db`; the session-log files moved under `src/`, and `e5013f6` overlaps it. Read it from disky's history:

```bash
git -C ~/c/disky show 876069c94:patches/auth-session-log.source.patch
git -C ~/c/disky show 876069c94:site/src/sessionDiagnostics.test.ts   # client regressions: in-flight connectivity change, 48-min gap, whitelist round-trip, abort privacy, Ray filtering, visibility ordering
git -C ~/c/disky show 876069c94:site/src/sessionsModel.test.ts        # model: later-success links and exclusions
git -C ~/c/disky show 876069c94:specs/r2-network-diagnostics.md
```

## Done when

Auth publishes a dist with the above and its tests. Then disky `cloud` bumps the pin, adds `life` to `site/functions/_lib/activityShape.ts` `KIND_DEFS` (`'Browser connectivity hints, lifecycle changes and long timer gaps'`, default `off`), and brings back the two disky test files. r2 picks that up on its next `cloud` merge.

## As built (auth, 2026-11-11)

- Ported from r2's patch onto the current logger. The per-request context, `life` events, Ray filter, cancel evidence and later-success links are as requested, and r2's four client tests pass unmodified against the package (`test/client-session-log-diagnostics.test.ts`).
- `e5013f6`'s `online` / `visibility` / `visible_ms` are no longer sent. `on` / `vis` / `visMs` replace them. The server still accepts the old fields, so clients on `baf7314` keep working. `offlineFailure` reads `on` / `vis`, falling back to the old names.
- **Change from r2's model test:** a failure that ended with `on: false` or `vis: 'hidden'` is an `offlineFailure`. It still shows its context and still links to a later success, but it isn't an error (lane `api`). The ported test in `test/react/session-log-model.test.ts` says so, and adds a failure that is still an error.
- The later-success link applies to any request that got nothing usable (a 5xx, or no response other than a cancel), whether or not it counts as an error.
- Fixed in passing: an app event's line no longer shows the server's `_received_ms`.
