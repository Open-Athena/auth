# Service grants: a per-grant `service` flag, settable on new and existing grants

Requested from disky's root session, 2026-11-14. Ryan, in that session: "go for SAs in auth. and we should be able to tag existing grants with the SA bit."

## Why

disky posts each grant's activity to `#<deploy>-admin` (one Slack thread per burst, sender = the grant's holder). Grants used by jobs (`gcs-snapshot-job`, `gcs-sheet-sync`, a VM-mode parity link) post routine bursts ("7 page loads · 1 URL change") that read like a person browsing and tell an admin nothing. Ryan: omit service accounts' routine activity "unless there's an error or sthg notable", the way disky's deploy notices post a red and then a green.

Today a service grant is only inferable by convention (`created_by` "job-token provisioning", no email). A link made by hand on the admin form looks exactly like a guest's. So the bit is explicit.

## 1. The flag (package)

- `Grant.service: boolean` (default false). Store it as a column or inside `subject_json`; the package's call. If it's a column, ship a migration under the grants migrations, nullable/default 0 so existing rows read false.
- Settable at mint (`NewGrant.service`) and editable afterwards on existing grants (`GrantPatch.service`), by staff/admin only, through the same admin routes that edit memo/holder/expiry today (`/api/auth/grants/:id` PATCH or equivalent). Every change is logged like the other grant edits.
- Exposed on `Auth` for a grant session (e.g. `auth.service`), so apps can branch on it without another lookup.
- Any grant minted by a job-token provisioning path the package knows about defaults to `service: true`.
- A service grant is never a person: minting one with `email` is refused (a person's link creates an account; a service shouldn't).
- Coordinate with `specs/activity-threads-and-anon-links.md` (§2 `anon`): `anon` and `service` are sibling per-link flags; same storage, same edit route, same admin UI pattern.

## 2. Activity (package, when the activity port in `activity-threads-and-anon-links.md` lands)

- A burst whose actor is a service grant posts nothing routine.
- It posts a red notice when something is notable: a run of errors (4xx/5xx above a small threshold within the burst), use of an expired or revoked grant, or first use from a new IP hash / user agent. A green follows when the next burst is clean. Reds and their green thread the way disky's deploy notices do (`site/deploy-notify`, run-length by color).
- Sender name says what it is ("gcs scan job (service)"), with a fixed service avatar instead of an identicon.
- Hooks so the app can override what counts as notable.

## 3. disky (consumer; disky's root session does this after the package ships)

- `/admin`'s Share links form: a "Service account" checkbox; the grants table shows the bit and lets staff toggle it on existing rows (Ryan's ask), next to Edit memo / Edit holder.
- Tag the existing job grants on each deployment (gcs-snapshot-job, gcs-sheet-sync, the VM parity link, cw/hf/r2 scan-job grants) once the toggle exists.
- `site/functions/_lib/activity.ts` follows §2 until disky moves onto the package's activity model.

## Out of scope

Changing what a service grant can access (scopes stay as minted); agent tokens (`/api/token`) stay personal.
