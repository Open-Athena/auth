# Resend provisioning envelope for email-code sign-in

*(Answers the "Upstream ask (auth pkg)" in marin-gcs-usage's `specs/oidc-cutover.md`: the runtime for passwordless email sign-in — `emailCodeAuth`'s four handlers, `d1PendingAuthStore`, `resendEmail`, `EmailCodeForm` — is shipped and tested, but a consumer still has to (1) invent the Pages-Function mount, (2) click through Resend's dashboard and paste DKIM/SPF records into the Cloudflare DNS UI, and (3) figure out which two secrets to set. This closes all three the way [`oauth-client-iac.md`](./oauth-client-iac.md) closed the Google-client gap: a dry-run-by-default CLI that scripts the whole envelope, a reference mount, and a README recipe. Researched 2026-09-23 against Resend's and Cloudflare's API references; see "What I verified".)*

## Feasibility verdict

**Yes — unlike the Google OAuth client, every step here has an API, so this one can be fully scripted.** Resend's domains API creates a sending domain and returns the exact DNS records it wants; Cloudflare's DNS API writes them; Resend's verify endpoint kicks off the check; `wrangler` stores the key. The irreducible manual residue is (a) having a Resend account and an API key with `full_access` (domains are account-scoped, and a `sending_access` key can't create one), (b) a Cloudflare API token with `Zone:DNS:Edit` on the zone, (c) accepting an ESP as a real dependency, and (d) the DNS-propagation wait, which is minutes on a Cloudflare-hosted zone but out of anyone's hands.

The ask said "Pulumi/TF module". The records *are* expressible in IaC — Terraform's `resend_domain` resource emits the same `records` list and `cloudflare_dns_record` consumes it — and the README says so for teams that already run a Cloudflare zone under Terraform. But the package ships a script rather than a module, for the same reason the OAuth provisioner did: the consumer surface is "one command, dry-run first", not "adopt a provider, a state backend, and a secret-in-state liability for two records and one key". The script is idempotent and re-runnable, which is the property people actually want from `apply`.

## What I verified (primary sources)

1. **Create domain** — `POST https://api.resend.com/domains`, body `{ name, region?, custom_return_path? }`; `region` defaults to `us-east-1` (also `eu-west-1`, `sa-east-1`, `ap-northeast-1`), `custom_return_path` defaults to `send` ([create-domain]). Response: `{ id, name, status, region, records: [...] }` where each record is `{ record: 'SPF'|'DKIM'|'Tracking', name, type: 'MX'|'TXT'|'CNAME', ttl: 'Auto', status, value, priority? }`. Two things the automation must handle: **record `name` is relative to the domain for SPF/DKIM (`send`, `resend._domainkey`, `<hash>._domainkey`) but a FQDN for Tracking (`links.example.com`)**, and **TXT values arrive pre-quoted** (`"\"v=spf1 include:amazonses.com ~all\""`) while CNAME values may carry a trailing dot.
2. **List domains** — `GET /domains` → `{ data: [{ id, name, status, region, ... }], has_more }`, `limit` ≤ 100 and `after` cursor ([list-domains]). No records in the list entries; `GET /domains/{id}` returns the same shape as create, including `records` ([get-domain]).
3. **Verify** — `POST /domains/{id}/verify` is asynchronous and returns just `{ object: 'domain', id }`; the domain goes `pending` and the caller polls `GET /domains/{id}` ([verify-domain]). Statuses: `not_started`, `pending`, `verified`, `partially_verified`, `partially_failed`, `failed` (no records within 72 h), `temporary_failure` (a previously verified domain whose records vanished; rechecked for 72 h) ([manage-domains]).
4. **Cloudflare DNS** — `POST /client/v4/zones/{zoneId}/dns_records` with `{ type, name, content, ttl, priority?, comment? }`; `name` is the *complete* record name including the zone, `ttl: 1` means automatic, `priority` is required for MX ([cf-create]). The list endpoint filters by `name` (exact, case-insensitive) and `type`, returning `result: [{ id, name, type, content, priority?, ttl, comment }]` ([cf-list]) — enough to make the write idempotent without keeping state.
5. **Secrets** — `wrangler pages secret put <NAME> --project-name <p>` and `wrangler secret put <NAME> --name <worker>` both read the value from stdin, which is how the OAuth provisioner already avoids putting a secret in argv.

## Shape

### `scripts/provision-resend.mjs`

Node ESM, built-ins only, mirroring `provision-oauth-client.mjs` (dry run by default, `--run` executes, `UsageError` for bad input, everything printed to stderr, exported helpers, `import.meta.url` main guard). Four sub-steps, each idempotent, each skippable via `--only`:

- **`create`** — list domains; if `--domain` is already registered, reuse it (and fetch its records); otherwise `POST /domains` with `--region` / `--return-path`. Prints the record table in both modes. A dry run with no existing domain can only print the request it would send — the records don't exist until Resend mints them.
- **`dns`** — for each Resend record: normalize the name to a FQDN, list what the zone already has at that name/type, and skip if an entry with the same normalized content is present (TXT compared with outer quotes stripped, CNAME/MX with the trailing dot stripped). Otherwise create it with `ttl: 1`, MX `priority`, and `comment: 'resend: <record>'` so the records are recognizable in the dashboard. `--dmarc` adds `_dmarc.<domain> TXT "v=DMARC1; p=none;"` only if no DMARC TXT exists there at all — an existing stricter policy is never downgraded.
- **`verify`** — skip if already `verified`; else `POST /domains/{id}/verify` and poll `GET /domains/{id}` with exponential backoff (2 s doubling, capped at 30 s) until `verified` or `--wait` seconds elapse. Default `--wait 0` is a single check after the kick-off, because on a fresh zone the honest answer is "come back in a few minutes" (`--only verify --wait 600`). Exit 1 on `failed`/`temporary_failure`, 0 otherwise (pending is a normal intermediate state, not an error).
- **`secrets`** — `RESEND_API_KEY` (the same env var the script authenticates with — never printed, never in argv, piped to wrangler on stdin) and `MAIL_FROM` (`--from`), to a Pages project (`--pages-project`) or a Worker (`--worker`). `MAIL_FROM` isn't secret, but a secret is the one write path `wrangler` offers for a Pages project without touching the dashboard or `wrangler.toml`, and it's what the reference consumer reads.

Flags: `--domain <name>` (required), `--zone-id <id>` (required for `dns`), `--from <addr>` (required for `secrets`; `addr@domain` or `Name <addr@domain>`, must be at `--domain` exactly — a subdomain is a separate Resend domain), `--pages-project <name>` | `--worker <name>` (exactly one, required for `secrets`), `--region` (default `us-east-1`), `--return-path` (default `send`), `--dmarc`, `--wait <s>`, `--only <steps>` (comma-separated subset of `create,dns,verify,secrets`), `--run`. Tokens come from env only — `RESEND_API_KEY`, `CLOUDFLARE_API_TOKEN` — and a missing one is a `UsageError` naming the variable. The Resend key is needed by every step (`dns` reads the domain's records from Resend; `secrets` stores the key itself); the Cloudflare token only by `dns`.

Dry run performs the read-only GETs (list domains, list DNS records) so it can print exactly what a `--run` would do — which records would be created versus already exist — and executes no POST and no `wrangler`. That's `terraform plan`, and it's the point.

### `test/provision-resend.test.mjs`

`main(argv, deps)` takes injected `env`, `fetch`, `exec`, `err`, `sleep`, so the tests drive the whole flow without a network or a shell: assert the exact request sequence (`method`, `url`, parsed `body`) and the exact printed lines. Cases: reuse of an existing domain (no POST), creation when absent, idempotent DNS skip vs create, relative→FQDN name normalization and TXT-quote / trailing-dot content normalization, `--dmarc` add-if-absent, dry run sends no POST and runs no command, secrets go to `wrangler` on stdin with the key absent from argv and from output, `--only` gating, missing-env `UsageError`s, `--from` validation, and the verify poll/backoff. Pure helpers (`fqdn`, `normalizeContent`, `dnsRecordBody`, `secretPutArgs`, `formatRecords`, `parseArgs`) get direct exact-equality tests too.

### `examples/pages-functions/auth/email/[[path]].ts`

The reference mount for the four handlers, generalized from marin-gcs-usage's `functions/auth/email/[[path]].ts`: a minimal `Env` (`DB`, `SESSION_SECRET`, `RESEND_API_KEY`, `MAIL_FROM`, optional `APP_NAME`), a `gateFor(env)`, and the path-suffix switch — `start`, `code`, `verify`, `poll`. Dormant (503) until the two Resend vars are set, so the file can ship before provisioning is done. Mounted at `/auth/email/*` on purpose, outside `authRoutes`' `/api/auth/*`, so there's no precedence question. Kept out of `tsconfig` `include` and out of `package.json` `files` (it's a template to copy, not a module to import); typechecked by hand against the built package before commit (a scratch `tsconfig` under `tmp/` with `paths` → `dist/`).

### README

A "Provisioning Resend" paragraph under the email-code section: the one-line invocation, what stays manual, the IaC alternative.

## Acceptance

- `pnpm test` / `pnpm typecheck` / `pnpm build` green; no new dependencies; `src/` untouched.
- Running the script twice with `--run` is a no-op the second time (domain reused, every DNS record skipped, verify skipped once verified, secrets rewritten with the same values).
- No path prints or argv-embeds `RESEND_API_KEY`.

[create-domain]: https://resend.com/docs/api-reference/domains/create-domain
[list-domains]: https://resend.com/docs/api-reference/domains/list-domains
[get-domain]: https://resend.com/docs/api-reference/domains/get-domain
[verify-domain]: https://resend.com/docs/api-reference/domains/verify-domain
[manage-domains]: https://resend.com/docs/dashboard/domains/manage-domains
[cf-create]: https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/
[cf-list]: https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/

## As built (2026-09-23)

Shipped as specced: [`scripts/provision-resend.mjs`](../../scripts/provision-resend.mjs) (30 exact-equality tests in `test/provision-resend.test.mjs`, driving `main` with an injected `fetch`/`exec`/`sleep`), [`examples/pages-functions/auth/email/[[path]].ts`](../../examples/pages-functions/auth/email/%5B%5Bpath%5D%5D.ts) + its README, and the README's "Email codes" / "Provisioning Resend" paragraphs. No new dependencies; `src/` untouched.

Decisions the plan left open, and one thing found the hard way:

- **The Resend key is unconditional**, not per-step: the first cut gated it on `create|verify|secrets` and the `dns` tests caught that `dns` needs it too (the records come from `GET /domains/{id}`). Only `CLOUDFLARE_API_TOKEN` is step-gated.
- **A send-only key can't provision.** An accidental live `GET /domains` during a smoke test (the shell had a restricted `RESEND_API_KEY` exported) returned `401 restricted_api_key: "This API key is restricted to only send emails"`. The script surfaces that body verbatim (`GET <url> → 401: {...}`), and the README says "full-access key" explicitly. Scope the *stored* `RESEND_API_KEY` to sending afterwards if you like; the provisioning key and the runtime key needn't be the same one — but with a single `RESEND_API_KEY` env var they are, so the simplest path is one full-access key.
- **Every Resend record is applied, including `Tracking`** (`links.<domain>` CNAME): it's what Resend returns, it's harmless if click-tracking stays off, and filtering it would make "the records Resend wants" a judgement call.
- **TXT content is sent as Resend gives it** (pre-quoted); CNAME/MX targets lose their trailing dot. "Already present" compares the normalized forms (quotes stripped, dot stripped, hostnames lowercased), so Cloudflare's echo format doesn't matter.
- **DMARC presence check is by prefix** (`v=DMARC1`), not by content, so an existing `p=quarantine`/`p=reject` is left alone; the record is tagged `resend: DMARC` like the others.
- **Verify polling**: delays 2 s → 4 s → 8 s → … capped at 30 s, stopping when the next sleep would exceed `--wait`; `failed`/`temporary_failure` exit 1, `pending` exits 0 with a "re-run with `--only verify --wait 600`" hint. `partially_verified` and friends are treated as not-yet-verified.
- **Dry run still GETs** — list domains, get domain, list DNS records — which is what lets it print the exact records that would be created versus skipped. Without a key it can't plan, and that's the honest behaviour: a plan that can't read the current state isn't a plan.
- **`MAIL_FROM` is stored as a secret**, not a var, because `wrangler pages secret put` is the one CLI write path for a Pages project that doesn't touch the dashboard or `wrangler.toml`, and it's what the reference consumer reads.
