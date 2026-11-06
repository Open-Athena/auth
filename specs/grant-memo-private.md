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
