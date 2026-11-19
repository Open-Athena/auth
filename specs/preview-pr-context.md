# Preview consent: verified PR context from GitHub

Requested by Ryan (2026-11-19), from disky's r2 PR-preview pilot (Open-Athena/disky#9).

## Problem

A preview client's consent page (`previewConsentPage`, `src/provider/routes.ts`) says only that `pr-9.oa-r2-usage.pages.dev` is "a preview of oa-r2-usage, built from a branch whose code may not have been reviewed". It doesn't say which PR, branch, author or commit, so the person deciding can't tell whether this is the preview they meant to open.

## Rejected: app-supplied content

The app must not supply this context: no link slot, no template, no component. The page exists because the preview's code is untrusted, so anything that code provides (a link, a label, a React component) is exactly what an attacker's PR would forge, and a component would run on the broker's origin. The page stays entirely the broker's, and its facts come from a source the PR's author doesn't control.

## Design

### 1. A preview client names its source

`RegisteredClient` / `NewClient` gain an optional `previewSource`, allowed only when `preview` is true:

```ts
previewSource?: {
  provider: 'github'
  /** `owner/name`. */
  repo: string
  /** The host label for PR n: a template with exactly one `{n}`, e.g. `pr-{n}`. Must match `LABEL` for every n. */
  label: string
}
```

Only an admin can set or change it, through the client management API (`specs/done/client-management-api.md`). Each change is a `ClientEvent` (`update`, `detail` = old → new). Migration: one nullable JSON column on the clients table.

### 2. The broker looks up the PR itself

When a preview client's `/authorize` reaches the consent step (the `client.preview` branch, before `previewConsentPage`):

1. Parse the redirect host's label against `previewSource.label`. If it doesn't match (e.g. `dev`, a deployment hash), there is no PR context: show today's page with "not a PR preview: no PR found for this address".
2. `GET https://api.github.com/repos/{repo}/pulls/{n}` with the broker's own read-only GitHub credential (a GitHub App installation, or a fine-grained token with `pull_requests: read` on the registered repos; a secret on the broker, never the client's). Cache by `(repo, n)` for 60 s.
3. Optionally, and preferably once it's reliable, confirm the host really serves this PR: the GitHub deployments the preview workflow records (`GET /repos/{repo}/deployments?sha=<head>`, `environment_url` = this host), which also gives the deployed SHA. disky's `cf-preview` action records one per publish. Without a match, say "PR found; deployment not confirmed" rather than claim it.

### 3. What the page shows

All of it broker-rendered and escaped:

- **Repo and PR:** `Open-Athena/disky #9`, linked to the PR.
- **Title:** shown as quoted data and labeled as the author's, capped at about 120 characters. The title is attacker-controlled text, so it must never read as the broker's own words.
- **Author:** login and avatar, from GitHub.
- **Branch:** head → base (`rw/r2-preview-pilot` → `r2`), linked. A PR from a fork is flagged prominently: "from a fork: `someone/disky`".
- **Head commit:** the short SHA, linked; plus the deployed SHA when step 3 confirmed it, with a note if they differ ("the preview is behind the PR's head").
- **State:** open, draft, closed or merged, and when it was last updated.

### 4. Policy

- **Closed or merged PR:** refuse with `access_denied` and a page that says so. A retired preview should be gone already; one still serving is stale.
- **GitHub unreachable or rate-limited:** show today's generic page plus "couldn't check GitHub: PR details unavailable". Don't block sign-in, and don't show anything from cache older than the TTL.
- **Consent memory:** stays per `(subject, client, host)` for 7 days, as now. Open question: should a new head author, or a fork, ask again?

## Tests

- Unit: label template parsing (`pr-{n}` ↔ host; refusals for templates that can produce invalid labels); registry validation (`previewSource` only on preview clients, repo shape); the page's exact HTML for an open PR, a fork, a closed PR, GitHub down, and a non-PR host (exact-equality / golden).
- `test-browser/preview-consent.spec.ts`: a mocked GitHub API; the page shows the PR and the click still posts back with the real Origin.

## Rollout

Register `previewSource` on disky's four preview clients (`oa-{hf,cw-s3,gcs,r2}-usage-preview` → `Open-Athena/disky`, `pr-{n}`), with Ryan's go per client. Then open a PR preview on any of them and check the page (r2's pilot pattern: create, sign in, close).
