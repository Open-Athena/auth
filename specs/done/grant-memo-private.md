# A share link's memo should stay private to whoever minted it

*(Requested from `jobs.oa.dev`, `~/c/oa/jobs`, 2026-11-05.)*

## Context

`<GrantMintForm>` presents "Memo" as the admin's label for a link, but it reaches the recipient. A minter writing a note like "anon RO" or "candidate, weak on X" exposes it to whoever opens the link.

Where it leaks:

- `gate.whoami` (`src/core/gate.ts`) returns `name: auth.grant.name` to the link session, so it's readable in the API response whatever the UI shows.
- `src/core/retained.ts` does the same when listing a browser's logins.
- `displayName` (`src/client/identity.ts`) falls back to it: `subject.name || whoami.name || subject.email || whoami.email`. That puts it in `<UserMenu>`, `<WhoamiChip>` and the disclosure components.

This partly comes from an older model where `name` was the person (the README still says "name it after the person you're sending it to"). The subject's name now fills that role, and the memo should be purely the minter's.

## Requirements

- Don't send a grant's `name` to the link session from `whoami` or the retained listing. Admin grant routes keep returning it.
- Remove the fallback from `displayName`. A link with no subject name or email is anonymous, and `anonymousLabel` already covers that.
- Update the `Whoami` type, `demo/src/pages/Dashboard.tsx` ("Link memo"), and the README's wording.
- Tests: a link session's `whoami` carries no memo, with and without a subject name; the admin list still has it; `displayName` returns null for an anonymous link.

## Worth checking

These are server-side uses of `grant.name`. Neither necessarily leaks, but both treat the memo as an identity:

- `src/session-log/index.ts`: `who` falls back to `a.grant.name`.
- `~/c/oa/transcripts/worker/index.ts:109`: `auth.grant.name ?? 'share link'`. Check whether a recipient can see that value, and whether transcripts links relied on the memo as the visible name. Those links would turn anonymous after this change.

This is backward-incompatible for any app relying on the fallback, so note it for downstreams.

## Downstream

`jobs` strips the field itself in `withoutMemo` (`worker/index.ts`). When a dist build has this, tell the `jobs` session; it removes that and bumps its pin.

## Status: done

A grant's `name` no longer reaches a link session. `GrantWhoami`, `AccountView` and `IncomingView` have no `name` field; `displayName` returns the subject's name, then an email, then null. Admin grant routes still return `name`, and a server handler still holds it as `auth.grant.name`.

### Differences from the above

More leak paths than the Context listed:

- `IncomingView.name` (`src/core/retained.ts`): the offer shown to someone who opens a link while signed in as someone else. Removed along with the listing's field. `AccountView.name` was always null for SSO rows, so the field went entirely.
- `who` in `src/react/Accounts.tsx` rendered the memo in `<AccountSwitcher>` and `<UserMenu>`'s account list. It is now subject name, then email, then "Share link" or "Account", so a new client against an older gate doesn't show a memo either.
- `IncomingLink` in `demo/src/pages/Dashboard.tsx` used the memo as its label; it now falls back to the link's email.

The "Worth checking" items:

- `src/session-log/index.ts`: this one did leak, so it changed. A link holding the admin scope that flips the session-log switch had its memo stored as `who`. `PUT` and `GET <base>/switch` return that to the holder and to any other admin, and `<SessionLogSwitch>` renders "Set by …". `who` is now the bound email, then the subject's name, then `grant:<id>`. Rows already stored keep their old `who` until the next write.
- `~/c/oa/transcripts/worker/index.ts:109`: a recipient can see this value. The index page renders "Signed in as <memo>" into the HTML of `/` for a link session. This change doesn't fix that, because the worker reads `auth.grant.name` directly. It needs its own change, e.g. `auth.grant.subject?.name ?? auth.grant.email ?? 'share link'`. After the `auth` bump, the user chip (`home/src/Chip.tsx`, `<UserMenu>`) goes anonymous for any link with no subject. That includes every link from `scripts/mint.mjs`, which inserts only `name`. Links minted at `/admin` with a Recipient keep their name.

Left as is, because only admins can read them:

- The allowlist note `with link "<memo>"` (`src/core/routes.ts`), read through the admin-only `/allowed` routes.
- `grantFor` still copies a request's name into the memo. The `/requests` route also sets `subject` from that name, so approved links keep it. A direct `gate.requestAccess({ name })` with no `subject` now displays the bound email instead.

### For downstreams

This is backward-incompatible: `whoami.name` is gone, and a link with only a memo now displays as anonymous. Put the person in `subject` (`subjectName` on `POST /grants`). Anything rendering `auth.grant.name` server-side to a link session has to change on its own side, as transcripts does.
