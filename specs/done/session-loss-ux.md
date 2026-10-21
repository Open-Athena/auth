# Losing a session: back to the wall, with a reason

Status: implemented locally, 2026-10-21. No deployment, live migration or downstream pin change. Existing `authenticate()` callers keep their `Auth | null` contract.

## Why

On 2026-10-21 an admin revoked a share link on gcs.oa.dev. The server side is already instant: a grant session re-joins its grant on every request, and `sessionValid` refuses a revoked one. The holder's experience is less clean:

- **No reason.** The holder sees the generic sign-in wall, or a data pane's "not signed in" error, never "this link was revoked" (or expired, or rotated). The server knows why: `denyReason(grant)` is logged on `deny`. But every 401 body is a bare `{error: 'unauthenticated'}`.
- **A data 401 doesn't reach the wall.** `useWhoami` refetches on window focus, so a refocused tab does fall to `AuthGate`. But an app request that 401s in a focused tab (a drill, a filter) only errors that request. The app keeps rendering what it already had until the next focus.
- **Leftovers in the browser.** The dead cookie is expired only on `/whoami`. A gated app route that 401s leaves it set. Apps that let the browser keep `private` copies of gated JSON (gcs does, `max-age`) can still show those from the HTTP cache after the session is gone.

## Change

1. **A typed denial.**
   - `gate.authenticate` (or whatever `identify` sits on) reports why a presented session failed: `revoked | expired | rotated | delisted` (an SSO email no longer admitted) `| invalid` (bad signature or malformed).
   - A helper, e.g. `gate.unauthenticated(req, why)`, builds the 401 for any gated route: body `{error: 'unauthenticated', reason}`.
   - When the session cookie is what failed, under the same "not when a `Bearer`/`?key=` was presented beside a live cookie" rule `/whoami` uses today, the 401 also:
     - expires the cookie;
     - sends `Clear-Site-Data: "cache"`, so the browser drops its cached gated responses for the origin. Not `"cookies"`: that would clear unrelated cookies too.
   - `/whoami` uses the same helper.
2. **React: one place to report a lost session.**
   - Export `reportUnauthenticated(reason?)` (or an `authEvents` emitter) that any app fetch calls on a 401.
   - It refetches whoami, so `AuthGate` swaps to the wall right away. The wall (`SignInPanel`) shows the reason: "This link was revoked", "This link expired", "This link was replaced; ask for the new one". Request-access is offered where configured.
   - `useWhoami` keeps `refetchOnWindowFocus` and adds `visibilitychange`. An optional `revalidateS` (default off; a few minutes is reasonable) covers a tab that sits focused and idle.
3. **No push channel.** SSE, WebSockets or Durable Objects to kick an idle tab is not worth it. Revocation is instant at the next request, and the remaining gap is a tab that makes no requests and is never refocused, which shows nothing new anyway.

## Tests

- Revoke, expire (with `expiryEndsSessions`), rotate with `endSessions`, delist: a gated route's 401 carries the reason, `Set-Cookie` expires the session, and `Clear-Site-Data: "cache"` is present.
- A bad `Bearer` beside a live cookie: no cookie expiry, no `Clear-Site-Data`.
- `reportUnauthenticated` → whoami refetched → `AuthGate` renders the wall with the reason text.

## Consumer (disky)

gcs's query client gets a global `QueryCache` `onError`: on a 401 it calls `reportUnauthenticated(reason)` and clears the query cache, so no stale data renders behind the wall. Its Functions' `requireViewer` / `requireStager` / `requireAdmin` 401s go through `gate.unauthenticated`. This ships after a dist build with the above.

## As Built

- `gate.authenticateResult(req, nowMs?, {logView?})` returns `{auth, reason, credential}`. `gate.unauthenticated(req, result?)` uses that result without another DB read, or resolves it if omitted. Reasons are signature-checked before distinguishing expired cookies from invalid ones. Anonymous requests return `reason: null`; missing grant rows are invalid. Disabling does not invalidate existing sessions, and grant expiry only does when `expiryEndsSessions` is enabled.
- `/whoami` and protected `authRoutes` 401s use the helper. A failed cookie expires only the configured cookie and sends `Clear-Site-Data: "cache"`, never `"cookies"`/`"storage"`. Failed explicit credentials, including empty Bearer/key values, do not clear a live cookie. Empty explicit credentials now fail closed instead of falling through to cookies. All helper responses are `no-store`.
- `reportUnauthenticated(reason?, {endpoint?})` and its framework-neutral subscription API live in `/client`; React and Vue reexport the report function. Match the source's whoami endpoint (default `/api/auth/whoami`). Observers revalidate authoritatively rather than treating a rejected Bearer as a logout command. They preserve a reported reason after cookie clearing, and clear it after successful authentication or explicit sign-out. React shares report/visibility side effects per QueryClient/endpoint so a navbar and gate do not cancel/refetch the same query twice.
- React `useWhoami` exposes `reason`; `AuthGate` passes it to `signIn(refresh, reason)` and supplies context to nested `SignInPanel`, with customizable reason text. Vue exposes a readonly reason ref and slot field; vanilla walls can use `sessionLossMessage`. Visibility checks and optional `revalidateS` are supported; periodic checks default off. No push transport.
- The demo data route and central fetch wrapper exercise the helper/report path, replacing the dashboard-specific refresh effect. A real-browser regression mints and redeems a link, revokes it while the tab stays focused, verifies the data 401 and header, observes automatic whoami revalidation, confirms only the view cookie was removed, and renders the reason-bearing wall. Google UI is omitted in this test; auth and D1 are real.
- Live testing also exposed a preexisting navbar/link-exchange race: an in-flight anonymous whoami could arrive after redemption and strand the page at the wall. `AuthGate` now cancels/invalidate the matching query after exchange before releasing the probe; a deferred-response regression pins this behavior. Standalone `useKeyExchange` remains usable without a query provider.

Verification: 665 unit tests passed (one opt-in runtime test skipped); package build, root/demo typechecks, 63 production-bundle browser regressions and 30 local real-backend browser tests passed. Desktop dark/light and mobile screenshots were inspected. Chrome connector initialization failed, so this is Chromium/Playwright verification, not a claimed OA-profile CIC. Removing the cache-clear header caused 12 backend tests to fail; restoring it returned the focused suite to green.

Consumer caveat: discard/cancel private app query/store caches without removing the identity query while it revalidates. The header signals browser HTTP-cache clearing, not application-memory/service-worker-store erasure, and its support depends on a secure context. Successful sensitive responses should remain `no-store` where appropriate. No mechanism can erase already-read/copied content. Downstream disky changes remain in that project's ownership; README's Session Loss section supplies the integration recipe.
