# Return a log row's client fields from `GET /log`

From disk-tree's m3 deployment (`~/c/disky/wt/m3`, 2026-10-07). Its share-link console (`site/src/AdminPage.tsx`) now opens a per-link activity table under each link's redeem count, fed by `GET <basePath>/log?grant=<id>`.

## Gap

`access_log` already records `ua`, `ip_hash` and `referer` on every redeem/deny/view, but `d1AuditQuery().recent()` selects only `id, ts, event, grant_id, session_sub, path, reason, country`. So an admin asking "who redeemed Bob's link, from what?" sees two `redeem` rows from `US` and can't tell one browser from two, or a laptop from a phone.

Measured on disk-tree's prod D1: the "Internal guest users link" has 2 redeems, from 2 distinct `ip_hash`es, both a desktop Chrome UA. None of that reaches the console.

## Change

1. `recent()` (`src/adapters/d1.ts`) also selects `l.ua`, `l.ip_hash`, `l.referer`, and returns them on each event (the memory/testing adapters too).
2. Add them to the event type in `src/core/types.ts` / `audit.ts` (nullable).
3. Tests: extend the `recent()` / `/log` route tests with exact-equality rows carrying all three.

`ip_hash` stays the HMAC it is (it correlates clients without retaining addresses). The console shows its first 8 chars as a client id, which is enough to tell redeemers apart. Returning raw IPs would mean storing them, and that's a privacy-policy decision, not part of this change.

## Also: log where a client is, not its address (decided: Ryan, 2026-10-07)

Ryan's call: keep IPs hashed, never stored raw, and log the location and network Cloudflare already provides instead. With each request, `request.cf` carries `city`, `region` and `asOrganization` (the ISP or company network, e.g. "Comcast", "Amazon.com"). Together they answer "is this the person I sent it to?" without retaining an address.

4. Migration: add nullable `city`, `region`, `as_org` columns to `access_log`. Additive only (no table rebuild: D1 enforces foreign keys, and consumers apply this package's migrations to their prod D1).
5. The audit sink fills them from `request.cf` wherever it already fills `country`, and `recent()` returns them.
6. Tests: a request with a `cf` object lands all three; one without leaves them null.

## Consumer

disk-tree's `GrantLog` already renders `ua` / `ip_hash` when present (hidden columns otherwise); it will add `city`/`region`/`as_org` beside `country`. Once this ships as a dist build, disk-tree bumps `@open-athena/auth` in `site/package.json` and applies the new migration to its D1.
