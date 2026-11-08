# Bounded Retained-Login Hardening

Status: atomic retained email-proof completion implemented and locally verified. Gate-wide rate admission remains open. This is a bounded improvement to [multiple logins], not completion of that entire design.

## Failure Reproduced

Previously, `emailCodeAuth` called `PendingAuthStore.consume()` before `gate.signIn()`. A full retained browser returned `409` after spending valid proof; removing a login could not make the original code retryable. The new regression test failed on that exact `consumedAt` change before the fix.

## Implemented Boundary

`EmailProof` carries the pending row ID, exact email, proof kind, hashed evidence, and the configured guess cap for codes. Neither a pending ID nor an email alone is sufficient. `gate.signIn` accepts this as its optional fourth argument and forwards it only to retained sign-in. Existing policy refusal and sign-in audit behavior remain in the gate. The email handler does not independently consume proof in retained mode. Single-cookie flows retain their existing consume/sign-in behavior.

`RetainedStore.commitEmail(input, nowS)` requires `pending_auth` and the retained tables in the same database. The adapter derives the session principal from the email bound to the proof; it does not accept a caller-supplied principal. Within one D1 batch it:

1. Diagnoses invalid proof, stale/dead browser context, or insufficient capacity within the transaction.
2. Claims a fresh internal operation only when proof, browser binding, expected selection and capacity all pass.
3. Consumes proof after rechecking hash, email, unconsumed state, expiry and the code guess cap.
4. Inserts the email session, updates selection/version, and revokes any prior login for that same email.
5. Verifies the completed state and returns the resulting selection from inside the transaction.

The existing CHECK-constrained `retained_operations.stage` turns an unexpected zero-row dependent write into a SQL fault, rolling back the batch. Batch result inspection is not used as compensation for partial success. This follows the existing incoming-link implementation and [D1's transactional batch contract]. No new schema or migration is needed; existing migrations through `0004` suffice.

Refusals leave proof, sessions and selection untouched. A full browser reports `retained-login-capacity`; removing a login allows the original unexpired proof to be retried. A context conflict may retry once against the fresh browser snapshot. Invalid/expired/spent proof reports `email-proof-invalid`, which the handler maps to its existing uniform `400 { ok: false }` code failure or no-cookie magic-link redirect, not a capacity error. SQL/storage faults throw.

The code guess cap is rechecked in the write transaction, closing the read/check-to-commit race. A valid magic link still works after the code guess cap, preserving the previous distinction between a high-entropy link and a guessable six-digit code. Both paths consume the same row, so concurrent code/link completion can produce only one retained session.

## Verification

- The capacity regression fails before the fix and passes afterward, including remove-and-retry with the original proof.
- `test/retained-hardening.test.ts` checks policy refusal, proof hash/email/expiry/attempt-cap/reuse guards, gate/handle/browser/selection binding, capacity and replacement behavior, concurrent code/link completion, selector collision, zero-row dependent writes, and injected faults at every batch statement. Failure tests compare complete database snapshots.
- Mutation verification inverted the code-hash equality guard. The wrong-proof test failed because a session was minted, then passed with the guard restored. Log: `tmp/retained-hardening-mutation.log`.
- Local workerd/D1 verification passes with `OA_D1_RUNTIME=1 pnpm exec vitest run test/retained-hardening.test.ts`. This uses only ephemeral local databases and loopback listeners, never production bindings or credentials.
- Existing retained-store, retained-gate and email-code tests continue to pass.

## Explicit Limits

- Policy/provider callbacks and the subsequent audit write are outside the database transaction. Policy refusal before completion does not consume proof; there is no cross-system transaction with an external policy change or audit failure.
- This does not introduce idempotent email response replay. Reusing spent proof is rejected and never mints again. A lost response after a committed completion does not undo its session; a browser already holding its handle sees the committed selection. If the response containing a newly created handle is lost, another email proof may be needed. Bootstrap-before-completion and recoverable response replay remain separate design work.
- Browser bootstrap/legacy import still happens before the completion transaction. A failed completion may leave an empty newly bootstrapped set; this change does not promise rollback of that earlier bootstrap.
- Existing gate storage quotas remain in place, but they are not gate-wide rate admission. Existing bootstrap storage refusal still uses its previous retained-capacity error rather than the design's proposed `503` distinction.
- Existing bounded cleanup must still be scheduled. Internal email operation rows use `retryTtlS` and are removed by existing cleanup; they are not exposed as replay credentials.
- The non-retained email path, its count-then-send rate limits, and its independent proof consumption are unchanged.

## Gate-Wide Admission Follow-Up

Bootstrap and incoming-pending creation need atomic, store-backed admission in addition to their existing finite storage caps. A subsequent change should define bounded per-gate rate windows and their storage schema, claim admission in the same transaction as bootstrap/pending insertion, and reject with `429` for rate pressure versus `503` for storage pressure before proof consumption or redemption. Admission state must survive browser churn and Worker restarts, count attempted allocations appropriately, and remain bounded independently of cleanup. Gate integration and response mapping must be explicit; a count-then-insert helper is insufficient.

This follow-up was deliberately not implemented as an unused helper or a new incompatible gate API in the present change.

[multiple logins]: multiple-logins-and-account-switching.md
[D1's transactional batch contract]: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
