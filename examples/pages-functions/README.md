# Pages-Function mounts

Reference files to copy into a Cloudflare Pages project's `functions/` directory. They are templates, not part of the package: not built, not published, and not on any import path.

- [`auth/email/[[path]].ts`](auth/email/%5B%5Bpath%5D%5D.ts) — the four `emailCodeAuth` handlers (`start`, `code`, `verify`, `poll`) at `/auth/email/*`, dormant until `RESEND_API_KEY` + `MAIL_FROM` exist. Provision those with [`scripts/provision-resend.mjs`](../../scripts/provision-resend.mjs); apply `migrations/` first.

The mount reads `DB` (D1) and `SESSION_SECRET` like every other route; replace `gateFor` with however your app already builds its gate so email sign-ins share the same allowlist and sessions.
