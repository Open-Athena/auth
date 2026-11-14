# OA Groups authorization setup

Status (2026-11-14): the SA exists; the request below is ready to send but not sent. `groups-reader@oa-auth-509611.iam.gserviceaccount.com` (unique ID 118214575437799181928) was created in GCP project `oa-auth-509611`, with the IAM and Admin SDK (`admin.googleapis.com`) APIs enabled there. It has no key, no Workspace role and no domain-wide delegation yet. The first group to sync is `marin-owners@openathena.ai`, which should drive admin access on gcs.oa.dev. Still not established: the Workspace grant, a credential, a running central sync and any deployed Groups policy.

## Copyable Workspace Admin Request

```text
Subject: Read-only Google Groups access for OA app authorization

Could an OA Google Workspace superadmin assign the prebuilt Groups Reader role to our directory-sync service account once it is created?

Service-account email: groups-reader@oa-auth-509611.iam.gserviceaccount.com

The first group we need to read is marin-owners@openathena.ai; please confirm the role assignment covers it.

Admin console: Account > Admin roles > Groups Reader > Assign admin > Assign service accounts > enter the confirmed SA email > Add > Assign role. Please confirm the assignment and any group-category restrictions; the grant must cover the authorization groups we agree to sync.

This is read-only membership lookup, not group ownership or membership management. Please do not grant Groups Editor/Admin, Super Admin, or domain-wide delegation. The SA will act as itself, without impersonating a user. The planned Directory OAuth scope is https://www.googleapis.com/auth/admin.directory.group.member.readonly.

We will handle GCP project/SA creation, API enablement and secure runtime credential placement separately with the GCP project operator. No private key or token is needed in this reply. Please flag any tenant restriction that prevents this role assignment rather than broadening access.
```

Google documents direct [service-account role assignment] and the read-only [Groups Reader role]. Its optional restrictions distinguish categories such as security/non-security groups; do not assume an arbitrary per-group allowlist. The request names the real SA email above.

## How Often Is The Grant Needed?

Once per Workspace, not once per group or per app. Groups Reader is a tenant-wide admin role: assigned to `groups-reader@oa-auth-509611.iam.gserviceaccount.com`, it lets that account read every group's membership in `openathena.ai`, unless the super admin restricts it to group categories (security / non-security). Adding a group later (another app, another team) is config on our side: add it to the central sync's group list and map it to scopes in the consuming app. It needs no new grant. A new grant is needed only for a new SA (e.g. replacing this one), or if the role was restricted to categories and a new group falls outside them.

The GCP side (the SA and the enabled APIs) can be code: `~/c/oa/ops/gcp` already manages GCP resources with Pulumi. The role assignment can be code too, via the Admin SDK's `roleAssignments` API or Terraform's `googleworkspace` provider. Either way it runs with a super admin's credential, so for a one-time assignment the console click is simpler and keeps that credential out of automation.

## Who Needs Which Permission?

| Task | Authority needed | Workspace superadmin needed? |
|---|---|---|
| Create the SA in an agreed OA GCP project | Project IAM permission `iam.serviceAccounts.create`, e.g. `roles/iam.serviceAccountCreator`; IAM API enabled | No; this is GCP IAM, not Workspace administration. See [SA creation]. |
| Enable Admin SDK API (`admin.googleapis.com`) | Project `serviceusage.services.enable`, e.g. `roles/serviceusage.serviceUsageAdmin` | No; see [API enablement] and [Directory API setup]. |
| Create/manage a JSON key if approved | `roles/iam.serviceAccountKeyAdmin` on the SA (or equivalent permission); organization policy must permit key creation | No; a GCP organization-policy administrator may separately be needed if keys are blocked. Do not disable a policy by default. See [SA keys]. |
| Assign Groups Reader to the SA | Workspace Admin console role assignment | Yes for Google's documented console procedure; GCP Owner/Editor or an OAuth scope alone does not grant this. See [service-account role assignment]. |

There is no separate blanket Workspace "enable Groups OAuth" switch in the selected role-assigned design. API enablement is a GCP task; Workspace authorization is the Groups Reader assignment. Tenant-specific API restrictions, if encountered, need a concrete error and separate review. Domain-wide delegation (DWD) is a supported legacy adapter option, not a required setup step: omit `subject`/JWT `sub`. Do not make the SA an OWNER to avoid asking for read access; ownership grants mutation powers, unlike Groups Reader. Google documents [member roles].

The current token helper takes a service-account JSON key (`client_email`, `private_key`); it does not implement a keyless workload-identity credential flow. Choose the central runtime and an approved credential delivery/rotation path before creating a key. Place it directly in that runtime's secret store, not chat, mail, Git or per-app configuration. A key-policy restriction would require an explicitly reviewed exception or a new keyless integration, not silent fallback to DWD.

## Rollout Boundary

1. Choose the OA GCP project, central credential/scheduled-sync owner and authorization group list. The direction is one central directory reader alongside the `login.oa.dev` broker, not an SA key copied to every app. Creating this infrastructure remains separate work.
2. Create/confirm the SA and enable the API under project IAM; then supply its actual email to the Workspace superadmin. Obtain Groups Reader without ownership or DWD. Verify real Directory reads for every configured group before changing app policy. The existing verification CLI needs explicit `--api directory` and no `--subject`; it prints member emails, so keep output restricted.
3. Apply the optional Groups D1 migration to the chosen store and schedule `syncGroupSnapshots` every 5 minutes. It defaults to `api: 'directory'`; the older `syncGroupsToAllowlist`, `listGroupMembers` and verification CLI still default to Cloud Identity. The older allowlist helper does not provide independent overlapping snapshots or their hard freshness bound.
4. Each app owns its group-email-to-scope mapping and checks current evidence on every protected request, including existing sessions. Only app-relevant memberships/entitlements should cross the central boundary; never ship the directory key or a global scope union. Central distribution and its authenticated consumer/cache contract are not implemented by the snapshot library. Do not claim fleet rollout until that path is built and tested, preserving the original `fetchedAt`.
5. Verify overlap, removal, outage/expiry, nested/external members and suspension behavior in the consuming app. Explicit manual/break-glass policies are separate grants, not implicitly revoked by Groups removal.

## Membership And Freshness Limits

- Directory mode requests `includeDerivedMembership=true`, which Google defines as including indirect membership ([members.list]). The adapter keeps emailed `USER` rows and drops `GROUP` rows. It is not a direct-only policy and does not recursively traverse external tenants itself; verify intended nested-group visibility in OA before relying on it.
- Cloud Identity mode lists direct `USER` memberships only. Its transitive query APIs have [edition restrictions] and are not used by this adapter. Switching APIs is a policy change, not an interchangeable credential workaround.
- Google permits members outside the tenant ([member resource]). The adapter does not enforce OA-managed identity, reject external emails or resolve aliases to stable user IDs. App/broker identity policy must separately enforce the desired managed-Workspace or explicit external-access rule; do not infer it from group membership or an email suffix alone.
- Directory mode excludes only rows explicitly marked `SUSPENDED`; absent/other status is accepted. Cloud Identity mode does not check suspension. Neither performs an authoritative per-request account-status lookup. Blocking new Google login is not proof that an existing app session is revoked; suspension needs tenant verification and an explicit enforcement bound before rollout.
- `groupPolicy` defaults to `maxAgeS=900`: age must be nonnegative and strictly less than 900 seconds. Missing, future-dated, invalid, stale or empty evidence contributes no scopes. Independent fresh groups may still grant their mapped scopes. Checks must run per request, not only at login.
- A failed Google listing causes no snapshot writes and never refreshes `fetchedAt`; successful empty listings remove membership. D1 rejects older and same-second replacements. Fetching all groups first is not an atomic multi-group database transaction: a storage failure can leave a partial write, with each group's own freshness bound intact.
- Once removal is visible to the API, a healthy 5-minute schedule normally enforces it after the next successful sync plus processing/distribution delay, on the next protected request. During a failed sync, the last observation expires at 15 minutes. Google propagation and downstream cache delay must also be measured; this is not a 15-minute guarantee from the instant an admin edits Google. Never reset observation time at token issuance or cache refill. Login-only claims and broker logout alone do not revoke existing app permissions.
- Snapshots are keyed by lowercased configured group email, not immutable Google group ID. Reconcile mappings on rename/deletion; a failed lookup preserves old evidence only until expiry. Do not silently retarget a reused address.

## Pending Work

Actual rollout prerequisites: project/runtime ownership decision, SA creation and confirmed email, approved credential path, Workspace Groups Reader grant, real-tenant read/edge-case verification, scheduled sync/store migration, central distribution and per-app policy adoption. Existing project IAM, tenant restrictions and key-policy state were not inspected; they are not confirmed permission failures. This draft changes no infrastructure or deployed authorization.

Primary Google documentation checked 2026-11-09. Implementation references: [Directory adapter], [snapshot policy], [snapshot store], [snapshot spec] and the historical [sync implementation spec]. The historical owner-based HCCS setup is not evidence of an OA grant.

[service-account role assignment]: https://knowledge.workspace.google.com/admin/users/assign-specific-admin-roles#assign-a-role-to-a-service-account
[Groups Reader role]: https://knowledge.workspace.google.com/admin/users/prebuilt-administrator-roles
[SA creation]: https://docs.cloud.google.com/iam/docs/service-accounts-create
[API enablement]: https://docs.cloud.google.com/service-usage/docs/enable-disable
[Directory API setup]: https://developers.google.com/workspace/admin/directory/v1/quickstart/nodejs#enable_the_api
[SA keys]: https://docs.cloud.google.com/iam/docs/keys-create-delete
[members.list]: https://developers.google.com/workspace/admin/directory/reference/rest/v1/members/list
[member roles]: https://developers.google.com/workspace/admin/directory/reference/rest/v1/members
[member resource]: https://developers.google.com/workspace/admin/directory/reference/rest/v1/members
[edition restrictions]: https://docs.cloud.google.com/identity/docs/how-to/query-memberships
[Directory adapter]: ../src/adapters/google-directory.ts
[snapshot policy]: ../src/groups/index.ts
[snapshot store]: ../src/adapters/d1-groups.ts
[snapshot spec]: ../specs/group-snapshots.md
[sync implementation spec]: ../specs/done/google-directory-sync.md
