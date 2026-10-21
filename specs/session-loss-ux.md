# Losing a session: back to the wall, with a reason

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
