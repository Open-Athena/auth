# Headless share-link admin and user menu, with reference components

Requested for `transcripts.oa.dev` (`~/c/oa/transcripts`), which needs a link-admin page and an upper-right user chip. Disky has its own versions of both, and other OA apps will want them too. This repo's only implementations of the admin UI are `demo/src/pages/Admin.tsx` (633 lines, tied to the demo's sandbox, not exported) and the small `<WhoamiChip>`.

## Wanted

Two layers for each feature: **headless logic** that owns state and API calls and renders nothing, and **reference components** built only on that public logic, so an app can use them as they are, restyle them, or replace them.

### 1. Share links

**Framework-free controller, in `/client`:** `createGrantsController({ client })` over the existing `client.grants.*`.
- State: the grant list, loading/error, per-action pending state, and the one-time token from the last mint or rotate.
- Actions: `mint`, `update`, `disable`, `enable`, `revoke`, `rotate`, `activity`, `refresh`.
- Subscribable (`subscribe`/`getSnapshot`), so React, Vue and Svelte can all bind to it. The transcripts hub's SPA base is Svelte.
- **The raw token lives only in controller memory**, from the mint or rotate response until `dismissToken()`. It is never persisted or logged, and is lost on reload. It's the only moment a token exists outside the recipient's browser.

**Framework bindings:** `useGrants()` in `/react`, built on `useSyncExternalStore`. A Vue binding is optional, matching `/vue`'s current scope.

**Reference components in `/react`:**
- `<GrantsPanel>`: create form plus list, composed from the parts below.
- `<GrantMintForm>`: holder name, memo, email, expiry, max redeems, and **`scopes`**.
- `<GrantCard>`: status, scopes, holder, disable/enable, revoke, rotate, activity.
- `<GrantLink>`: shows the one-time link with a copy button and "you won't see this again". The app supplies `buildLink(grant, token)`, because link shape is app-specific (the hub's is `/<first-scope>/?key=<token>`).

**App-defined scopes**, instead of the demo's hardcoded `['reports']`:
- Prop: `scopes: { id: string; label: ReactNode; hint?: ReactNode }[]`, rendered as checkboxes, with at least one required.
- `hint` is where an app explains a consequence. The hub will use it for "0 of 622 sessions are visible to links": a project-scoped link can legitimately open an empty project there.

Keep the demo's sandbox framing, allowlist panel and request queue out of `<GrantsPanel>`. The demo should adopt `<GrantsPanel>` itself, proving the extraction, and keep those parts around it.

### 2. User menu

**Headless:** `useUserMenu({ whoami, client })` returns display name, avatar, kind (`sso` or `guest`), `isAdmin`, `signOut()`, and open/close plus ARIA/floating props. It should reuse `displayName`, `<Avatar>`, `useForgetWhoami` and `SELECTION_HEADER` handling from `<WhoamiChip>`, not fork them.

**Reference:** `<UserMenu>`: an avatar trigger for the page's upper-right corner, opening a menu.
- Built-in items:
  - who you are;
  - Profile, for `sso` only (opens `<ProfilePanel>`);
  - accounts (`<AccountSwitcher>`, when retained logins are on);
  - sign out.
- `items` prop for app entries: `{ key, label, href?, onClick?, when?: 'admin' | 'sso' | 'guest' }`. The hub adds "Share links" (`/admin`, admin only) and "Your drafts".
- A share-link guest sees the name and avatar on their link, with no profile entry, and always a way to sign out, as `<WhoamiChip>`'s `anonymousLabel` guarantees.
- `@floating-ui/react` for positioning and dismissal, as an optional peer dependency.

**Reference behavior:** disky's `UserMenu` in `~/c/disky/wt/gcs/site/src/SiteNav.tsx`: avatar trigger, identity header, app submenu (`Display`), Profile, API token, Log Out, plus a separate guest card. Disky should be able to replace its version with `<UserMenu>` plus `items`; its registry names and GitHub avatars stay in disky, passed as props.

### Mounting outside a React app

`mountUserMenu(element, props)` / `mountGrantsPanel(element, props)`, or documentation of the equivalent `createRoot` call, so a non-React page can host a component. The hub's AV SPA is Svelte and needs the chip mounted into its page. Include a default stylesheet with CSS variables for colors, since the hub needs a dark theme.

## Non-goals

- Per-session or resource-scoped links. Hub links stay project-scoped for now. Session filtering may come later, so don't build in the assumption that scopes will only ever be a flat list of project IDs.
- Any change to grant storage or routes, unless extraction reveals a gap.

## Tests

- Controller: exact state transitions for mint, failed mint and rotate; the token is present only until dismissed, and never in a `list` result.
- Controller: a refresh racing a mutation can't resurrect stale state.
- `<GrantMintForm>`: submits exactly the chosen scopes, and refuses none.
- `useUserMenu`: `sso`, guest and admin yield exact item lists; sign-out sends the selection header in retained mode.
- Browser (`test-browser/`): mint in `<GrantsPanel>`, open the link in a fresh context, and revoke it.

## Afterward

Tell the hub session which commit to pin. `~/c/oa/transcripts` is pinned at `0e81fea`, 39 commits behind `cf25b10`, and needs `/client` at least.
