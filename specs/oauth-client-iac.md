# IaC for per-app Google OAuth clients: feasibility spike

*(Spike for the `google-oidc` work item's "OAuth client provisioning" line: each deployed consumer — `marin-gcs-usage`, the `auth.oa.dev` demo, future apps — needs its own Google "Web application" OAuth 2.0 client. The adoption pain, verbatim: "I always seem to hit a wall around that part of it, a bunch of unintuitive cloud-console clicks." This asks whether that wall can be turned into `terraform apply` / a `gcloud` script. Researched 2026-09-19 against current primary sources; fetched pages saved under `tmp/`.)*

## Feasibility verdict

**No — creating a user-facing "Web application" OAuth 2.0 client (client id + secret, JS origins, redirect URIs) is not IaC-able today, and got *less* so in 2026.** Google exposes **no public API** to create a classic OAuth client or read back its secret; that step is Cloud-Console-only, "a manual door, full stop" ([API Evangelist, 2026-09-08][ae]). The one programmatic path that ever existed — the **IAP OAuth Admin API**, which backed Terraform's `google_iap_brand` / `google_iap_client` and `gcloud iap oauth-clients` — was deprecated 2025-01-22, stopped functioning for Terraform around 2026-01-19, and was **permanently shut down 2026-03-19** ([Google IAP migration doc][iapdep]); as of this writing that API is dead and the two resources have been **removed from the current Terraform provider** (absent from `website/docs/r/`, raw docs 404 — see "What I verified"). The seductively-named `google_iam_oauth_client` that *does* exist is a **Workforce Identity Federation** client for calling GCP APIs as a federated user, not a Sign-in-with-Google web client ([registry docs][tfwf]) — using it here would be a category error. So the honest answer to "can an adopter `terraform apply` their way to a client id/secret" is no; what we can do is **script everything around the one irreducible click-set and codify that click-set as a checklist**, which is what this spec recommends.

## What I verified (primary sources, not memory)

1. **Terraform Google provider — is there a non-IAP web OAuth-client resource?** No.
   - `google_iap_brand` / `google_iap_client` — **removed**. They enumerate before `iap_settings` in the alphabetical `website/docs/r/` listing yet are absent, and `raw.githubusercontent.com/.../iap_brand.html.markdown` returns `404: Not Found`. They were the historical way to mint a working web OAuth client (an IAP client doubles as a general client id/secret), always with sharp edges: one brand per project, brand creation only for **internal** (org-only) user type via API — external brands were always console-seeded — and the brand was effectively immutable. All moot now: the backing API is shut down ([iapdep]).
   - `google_iam_oauth_client` + `google_iam_oauth_client_credential` — present, subcategory "Cloud IAM", generated from `iamworkforcepool/OauthClient.yaml`. Description: *"Represents an OAuth Client. Used to access Google Cloud resources on behalf of a Workforce Identity Federation user."* Its `allowed_scopes` are `cloud-platform`/`openid`/`email`/`groups` (GCP-resource scopes), it lives at `projects/*/locations/*/oauthClients/*`, and the secret comes from the companion `_credential` resource ([tfwf], [tfwfcred]). This is **not** a "Sign in with Google" client and cannot be used as `src/adapters/oidc.ts`'s `clientId`/`clientSecret`. Do not reach for it because the name matches.
   - `google_identity_platform_oauth_idp_config` — present, but it *configures Google as an IdP inside a GCP Identity Platform / Firebase-Auth tenant*; it **consumes** a `client_id`/`client_secret` you already created, and pulls in the whole GCIP product (its own hosted sign-in) that `@open-athena/auth` deliberately doesn't use. Not applicable.
   - The standing feature request for a native non-IAP client resource ([gh6074], [gh16452]) remains unfulfilled; the blocker is upstream (no Google API), not provider effort.

2. **Consent screen / "brand" (now "Google Auth Platform" branding).** Still the least automatable step, and there is no Terraform/API to create or publish it for **External** user type. What remains manual: choosing **Internal vs External** user type (Internal needs a Workspace org and limits to org members; our adopters are External), filling the branding fields, and moving publishing status from **Testing** (capped at 100 test users, tokens expire fast) to **In production**. Verification (the slow, screenshotted-security-questionnaire path) is **only** triggered by sensitive/restricted scopes — `openid email profile` are non-sensitive, so an External app on those scopes publishes without Google review. That's the one piece of good news: our scope set dodges verification entirely.

3. **`gcloud` path.** No non-interactive command for a web-app client. `gcloud iap oauth-clients create` / `gcloud iap oauth-brands create` exist in the reference but hit the shut-down IAP API. `gcloud iam oauth-clients create` is the Workforce client from (1). There is no `gcloud alpha/beta` command that produces a classic Sign-in-with-Google client id/secret.

4. **Pulumi.** Same wall, same API. `gcp.iap.Brand` / `gcp.iap.Client` mirror the dead Terraform resources; `pulumi-google-native` has no non-IAP web-client resource. Pulumi buys nothing here.

5. **One Tap / FedCM specifics.** Modest and entirely a *field on the client you couldn't script anyway*: for GIS / One Tap the client needs the app's web origin in **Authorized JavaScript origins** — scheme + fully-qualified host (+ port), **no path, no wildcard**, HTTPS required for One Tap (localhost may use `http://localhost:<port>`) ([gsi]). Redirect URIs are **not** needed for One Tap's popup/JS-callback mode — only for the redirect (auth-code) flow, which is `src/adapters/oidc.ts`. The relying party (our app) hosts **no** `.well-known/web-identity`; that file is the identity provider's (Google's) responsibility under FedCM. So One Tap adds one required field (JS origin) and zero app-side well-known hosting.

6. **Minimal manual residue.** The client-create form itself: name, JS origins, redirect URIs, and clicking Create to reveal the id/secret. Everything up-to and downstream of that click is scriptable (see below).

## Recommended approach

Stop chasing a Terraform resource that doesn't exist, and instead ship a thin, parametrized **adoption CLI that scripts the whole envelope and hard-stops at the single manual gate**, turning "unintuitive console clicks" into "paste two values when prompted." Concretely, a `provision-oauth-client` script — inputs `{project, app_origin, redirect_uri(s)}`, outputs `{client_id, client_secret}` captured into the consumer's secret store — that does, in order:

- **Scriptable, before the click:** `gcloud config set project <project>`; `gcloud services enable iap.googleapis.com` (and any others the project lacks); assert the OAuth consent screen exists and is External + In-production (query is scriptable even though *creating* it isn't — fail loudly with the console link if not).
- **The one manual gate:** print the exact values to enter and a project-scoped deep link to the create form, e.g. `https://console.cloud.google.com/auth/clients/create?project=<project>` — application type **Web application**; **Authorized JavaScript origins** = `<app_origin>` (required for One Tap); **Authorized redirect URIs** = `<redirect_uri(s)>` (the `oidcCallback` URL, e.g. `https://<app-host>/auth/google/callback`). Then wait for the operator to paste back the generated `client_id` and `client_secret`.
- **Scriptable, after the click:** write the captured pair to wherever that consumer reads secrets — for a Workers/Pages app, `wrangler secret put GOOGLE_OAUTH_CLIENT_ID` / `..._SECRET` (or `wrangler pages secret put`); optionally mirror to Secret Manager if the org centralizes there. The public `client_id` can additionally be surfaced as a build var for the One Tap `<GoogleOneTap>` component (Ask 4).

Sketch (bash; `gcloud`/`wrangler` are the real commands — pseudocode only at the human gate):

```bash
provision-oauth-client --project oa-internal-450019 \
  --app-origin https://marin-gcs-usage.pages.dev \
  --redirect-uri https://marin-gcs-usage.pages.dev/auth/google/callback
# → gcloud config set project …; gcloud services enable iap.googleapis.com
# → assert consent screen: External + In production (else print console link, exit 1)
# → PRINT deep link + the three field values above; read -r CLIENT_ID CLIENT_SECRET
# → wrangler pages secret put GOOGLE_OAUTH_CLIENT_ID   (value: $CLIENT_ID)
#   wrangler pages secret put GOOGLE_OAUTH_CLIENT_SECRET (value: $CLIENT_SECRET)
```

This is deliberately *not* Terraform/Pulumi: neither can create the resource, and modeling a hand-pasted secret as TF state (the Workforce `_credential`'s secret lands in plaintext state — [tfwfcred] warns of exactly this) buys drift and a secret-in-state liability with no apply-time creation to show for it. A script that front-loads the enables, deep-links the form, and back-ends the secret capture removes ~90% of the clicks and, crucially, removes the *thinking* (which type? which origin format? where do the secrets go?) that is the actual wall.

## Manual residue / fallback (least-clicks console checklist)

If not using the script, the irreducible path per app is:

1. **Consent screen (once per project, skip if done):** Cloud Console → **APIs & Services → OAuth consent screen** (a.k.a. Google Auth Platform → Branding). User type **External**; fill app name + support email + developer email; scopes — leave default / add none (`openid email profile` are added by the client at request time and need no listing). **Publishing status → In production** (do not leave in Testing; the 100-test-user cap and short-lived tokens will bite). No verification prompt appears for these non-sensitive scopes.
2. **Create the client:** **APIs & Services → Credentials → Create credentials → OAuth client ID** → **Web application**. Name it for the app. **Authorized JavaScript origins:** the app's exact web origin (`https://host`, no path). **Authorized redirect URIs:** the callback URL (`https://host/auth/google/callback`). Create.
3. **Copy the `client_id` and `client_secret`** from the dialog (the secret is re-viewable later; but copy now).
4. **Store them** as the app's secrets (`wrangler pages secret put …`), and expose `client_id` (public) to the One Tap component if using Ask 4.
5. **Adding One Tap later to an existing client:** edit the client, add the web origin to Authorized JavaScript origins — that's the whole delta; no redirect URI, no well-known file.

## Where it should live

**In this `auth` repo, as adoption tooling — not in `oa/ops`.** The provisioning wrapper is inseparable from auth's own contract: the redirect URI *is* `oidcCallback`'s URL, the JS origin *is* what the `<GoogleOneTap>` component needs, and the secret env-var names are auth's. That's adopter-facing surface that belongs next to the adapter and its docs (e.g. `scripts/provision-oauth-client` plus a section in the adoption guide), so an adopter finds it where they find `oidc.ts`. `oa/ops` holds **Pulumi GCP/AWS configs for shared org infra**; a per-app Sign-in-with-Google client is (a) app-scoped, not shared, and (b) *not Pulumi/Terraform-manageable at all*, so there is nothing for an IaC-shaped repo to own. The one thing that could legitimately be an ops concern is the **GCP project** the clients live in and, if the org later centralizes secrets, a **Secret Manager** location — those are shared and IaC-able, and can be provisioned in `oa/ops` while the per-app client script stays here.

## Per-app vs shared client

**One client per deployment — keep it that way.** A shared client is only tempting *because* the per-app creation is manual, which is solving the wrong problem (fix the clicks, not the topology). Reasons per-app wins:

- **Blast radius.** A leaked client secret compromises exactly one app; rotation (delete + recreate the client, re-`secret put`) touches one deployment instead of every consumer at once.
- **Origin/redirect sprawl.** A shared client accumulates *every* app's JS origins and redirect URIs on one object — Google caps these, review gets muddy, and one fat-fingered edit breaks all apps. Per-app clients keep each app's allow-list to its own one or two entries.
- **Independent lifecycle.** Publishing status, One Tap origins, and eventual deletion when an app is retired are per-app decisions; a shared client couples them.
- **Least-privilege / auditability.** `aud` on every id_token names the specific app (the callback already checks `aud === clientId`), so a token minted for app A is inert at app B by construction — a property a shared client throws away.

The only cost of per-app is the manual create per deployment, which the checklist + script above is designed to absorb.

[ae]: https://apievangelist.com/2026/09/08/google-oauth-console-only-service-accounts-scriptable/
[iapdep]: https://cloud.google.com/iap/docs/deprecations/migrate-oauth-client
[tfwf]: https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/iam_oauth_client
[tfwfcred]: https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/iam_oauth_client_credential
[gh6074]: https://github.com/hashicorp/terraform-provider-google/issues/6074
[gh16452]: https://github.com/hashicorp/terraform-provider-google/issues/16452
[gsi]: https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid
