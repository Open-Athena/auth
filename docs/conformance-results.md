# OpenID provider conformance evidence

## Recorded Result

The hosted OpenID Foundation suite ran against `https://auth.oa.dev`, using the Basic OP static-client test plan, suite v5.3.4 (`server_metadata=discovery`, `client_registration=static_client`). On 2026-11-06, after the code-reuse regression was fixed and retested, the plan showed 20 passed, 6 warnings, 4 review and 5 skipped, with no failures. The version, variant and tally are also visible in the user's November 7 screenshot. This is a historical test result, not a claim of OpenID certification, a separate run against `login.oa.dev`, a security audit, or coverage of all library modules. The current implementation has changed since individual tests ran.

[Test plan][plan]: `fM45FwelhwWch`. The result and live code-reuse retest were verified by the preceding agent and the user; this document records that evidence and does not claim a new run. The code-reuse fix is source commit `0a32283`; subsequent production deployment and live retest occurred November 6. Conformance-only clients were removed afterward.

## Preserving and Sharing

Keep a screenshot or PDF of the complete plan, the suite version, configuration variant and run timestamps, plus the per-test logs. The Foundation [documents][export] **Publish for certification** as the mechanism for exporting a ZIP of plan logs. Treat that as a potentially public action: review the UI before confirming, and do not assume it is a private download. Exporting is not itself certification; certification has a separate submission process.

Keep raw exports private until reviewed: logs/configuration [may include credentials][sensitive-logs], tokens, user emails, photos or screenshots. The test clients are disabled, but that does not make every captured value safe to publish. Prefer sharing a sanitized summary with the tally and limitations above. Do not commit the existing `tmp/oidc-conformance/config.json`, which contains the old secret.

## Remaining Outcomes

- Warnings: `userinfo-post-body`, `scope-profile`, `scope-email`, `alternate-happy-flow`, `ensure-request-with-acr-values-succeeds`, `claims-essential`.
- Review: `prompt-login`, `max-age-1`, `ensure-registered-redirect-uri`, `ensure-request-object-with-redirect-uri`. Manual review is not recorded as completed.
- Skipped: address/phone/all-scope, unsigned-request-object and refresh-token cases; see the plan for exact test identifiers and reasons.

## Follow-up Order

The following is a triage plan, not a completed log review or a new finding. Preserve each test's detailed log and instructions before deciding its disposition. A warning is not automatically a security defect, and an automated REVIEW result is not evidence that its manual checks passed.

1. **Complete the four manual reviews first.** For `prompt-login` and `max-age-1`, check the recorded UI/authentication evidence and `auth_time`, including the upstream Google reauthentication behavior. For `ensure-registered-redirect-uri` and `ensure-request-object-with-redirect-uri`, document the exact registered redirect behavior and rejection of unregistered destinations. Record reviewer, evidence and disposition. Add a regression test for any discovered defect; do not just relabel the result.
2. **Inspect the email/claims warnings.** `scope-email` and `alternate-happy-flow` were previously described as extra email claims. Compare the actual logs to requested/granted scopes and the current code, then decide whether the disclosure is intended. `scope-profile` and `claims-essential` were described as missing profile/name claims. Check which data was available in that run and which claims the provider advertises/supports; do not fabricate names or mark optional data mandatory just to remove a warning. The current `claimsFor` is scope-aware and only emits a name when the gate has one; that code inspection does not close historical warnings.
3. **Decide bounded interoperability additions.** `userinfo-post-body` currently corresponds to a real implementation limitation: `/userinfo` accepts GET/POST but reads the bearer from the Authorization header only. Supporting the form-body transport is a possible small improvement, with tests rejecting ambiguous/multiple token transports; it is not required by our known consumers. `ensure-request-with-acr-values-succeeds` needs an explicit supported-authentication-context policy, not an invented assurance claim. Do not emit an `acr` implying MFA or stronger assurance than the upstream flow established.
4. **Explain the five skips, rather than implementing all optional features.** Confirm the precise skip reason per test against advertised capabilities. Address/phone data, unsigned request objects and refresh tokens are deliberately outside the provider's current narrow scope. Fix misleading discovery metadata if found; otherwise document these as unsupported. Refresh tokens in particular add a credential lifecycle and revocation surface that the first-party broker does not currently need.

The earlier suggestion to simply leave all six warnings alone was too broad: their individual disposition and the manual security reviews should be recorded before claiming the conformance work is finished. Source/unit tests can support that evidence, but cannot retroactively complete hosted manual reviews. A new hosted run requires explicitly re-enabling the removed test clients and deploying; neither has been done by this documentation change.

## Certification Decision

Do not publish for certification merely to add a GitHub link. Preserve a PDF/screenshot and privately downloaded per-test logs first (the UI offers a Download Logs control on each test). The Foundation's plan-wide ZIP export is part of its publishing/certification workflow, while formal certification separately requires a submission and declaration. Revisit that workflow after the manual reviews, warning/skip dispositions and sensitive-log review, if certification itself is a project goal.

[plan]: https://www.certification.openid.net/plan-detail.html?plan=fM45FwelhwWch
[export]: https://openid.net/certification/how-to-submit-your-certification-request/
[sensitive-logs]: https://openid.net/certification/fapi_op_submission/
