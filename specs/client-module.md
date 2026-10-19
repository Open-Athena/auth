# A framework-free `@open-athena/auth/client`

From the Slidev fork (`~/c/slidev`, Open-Athena/slidev), 2026-10-19. Slidev's Vue client is adding a "Get link" modal and a links table on top of `authRoutes` (`/api/auth/*`). disky's `/admin` (`site/src/AdminPage.tsx`) and the demo's `Admin.tsx` call the same routes with hand-written `fetch`es. A typed, framework-free client would serve all three.

## Ask

A new export, `@open-athena/auth/client`, with no React (or other framework) imports:

- **`createAuthClient({ basePath = '/api/auth', fetch = globalThis.fetch })`** returns typed wrappers for the routes in `src/core/routes.ts`:
  - `whoami()`, `logout()`;
  - `grants.mint(input)` returns `{ grant, token, allowed? }`; `grants.list({ active? })`, `grants.update(id, patch)`, `grants.revoke(id)`, `grants.disable(id)` / `enable(id)`, `grants.rotate(id, { endSessions? })`, `grants.activity(id)`;
  - `log({ grant?, limit? })`;
  - `allowed.list()` / `add` / `remove` / `sync` (optional for the first version).
- **Errors:** a non-2xx answer throws an `AuthClientError` with `status` and the route's JSON error body (401 not signed in, 403 missing scope, 404 unknown grant, 501 no audit).
- **Types:** move the JSON shapes (`Grant` as the routes serialize it, `MintInput`, `Whoami`, …) to a module both the routes and the client import, so the contract has one definition.
- **Share URL:** a helper `shareUrl(token, target = location.href)` that appends `key=<token>` to `target` (keeping its other query params). A link can then land on a page of the app (a Slidev slide), not just `/`.
- **Move the framework-free bits out of `src/react/`:** `exchangeKeyParam` / `hasKeyParam` (currently in `react/exchange.ts`, which imports React), `downscaleImage` (`react/AvatarField.tsx`), and `displayName` / `hasScope` (`react/types.ts`). Re-export them from `react` so nothing breaks.

Then the React hooks and the demo's `Admin.tsx` can use the client too (optional, later).

## Tests

- Each wrapper against `authRoutes` with the in-memory stores (`src/testing`): mint → list → update → revoke round trip; `shareUrl` keeps an existing query and a hash.
- Error mapping: 401 / 403 / 404 come back as `AuthClientError` with the right `status`.
- A check that `dist/client.mjs` imports no `react`.

## Consumer

Slidev will use local `fetch` wrappers in the same shape until this lands, then switch (its `specs/share-links.md`).
