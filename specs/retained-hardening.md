# Bounded Retained-Login Hardening

Status: atomic retained email-proof completion and integrated gate-wide allocation admission implemented. This is a bounded improvement to [multiple logins], not completion of that entire design.

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
- Gate-wide allocation admission supplements existing finite storage quotas; it is not a general request-rate limiter, per-person fairness mechanism, email-send limiter, or provider-attempt limiter. Rejected requests still incur bounded SQL work. A busy or malicious caller can exhaust the gate's shared allowance; deployment-level abuse protection remains useful.
- Existing bounded cleanup must still be scheduled. Internal email operation rows use `retryTtlS` and are removed by existing cleanup; they are not exposed as replay credentials.
- The non-retained email path, its count-then-send rate limits, and its independent proof consumption are unchanged.

## Gate-Wide Allocation Admission

`d1RetainedStore` applies admission inside `bootstrap` and `createPending`, not through a separate optional helper. Each batch diagnoses eligibility and pressure, claims a gate/kind counter, allocates the corresponding row, and finalizes the claim. The pending batch also changes selection/version and marks the proof ready. D1 serializes competing write batches; the eligibility/rate checks and writes occur in the same transaction. The counter's CHECK-constrained stage aborts the batch if allocation/readiness unexpectedly affects zero rows. A final scalar SQL assertion also aborts if a trigger suppresses the stage-finalization UPDATE itself. SQL faults at any statement roll back the counter and every allocation/selection write, without compensation.

The three optional `RetainedLimits` overrides are `admissionWindowS` (default `60`), `gateBootstrapsPerWindow` (`120`), and `gatePendingsPerWindow` (`240`). All must be positive safe integers; explicit `undefined`, zero, negative zero, fractions, non-numbers, nonfinite values and overflow are rejected. Omit a field to use its default. There is no disabling/infinite value. Epoch-aligned windows are `[floor(nowS / windowS) * windowS, next boundary)`, resetting exactly at the boundary. Backward movement to a previous window fails closed rather than resetting allowance. There can be two windows' allowance in a short interval spanning a boundary; this is fixed-window admission, not a sliding-window burst guarantee.

Only successful allocations count, including an empty browser later abandoned, or a pending proof later expired/consumed. Invalid bindings/proof, stale selection CAS, per-browser capacity, global storage/rate refusals and SQL failures do not debit. Bootstrap is still a separate earlier transaction: if bootstrap succeeds and later pending/email completion fails, that empty set and its bootstrap debit remain. Deleting/ending a browser, losing its response or changing cookies does not refund its allocation. Existing handles and completion/selection/removal do not allocate a browser or spend bootstrap admission. Incoming completion does not spend another pending admission; the allocation was already counted.

`retained_admission` has one current row per `(gate_id, kind)`, with kinds restricted to `bootstrap` and `pending`. Forward rollover overwrites the same row. No rows are keyed by handles, pending IDs, operation IDs or historical windows. Rows persist even after every browser expires, and `cleanup` deliberately never deletes them; therefore deleting old browser rows cannot reset the current allowance. Storage is at most two rows per trusted configured gate that has allocated, independent of traffic, windows and cleanup. It is not bounded against arbitrary caller-supplied gate IDs: `retained.gateId` (or the configured cookie-name default) must remain trusted, stable configuration. All writers for a gate must use this adapter and identical admission configuration; mixed old/new writers, manual counter deletion, changing gate IDs or inconsistent window sizes are outside the guarantee. Retired gate counters may only be removed administratively when no writer can use that gate again.

### Refusals And Consumers

`bootstrap` retains its `Promise<boolean>` contract and `createPending` its `Promise<SelectionContext | null>` contract. D1 global refusals now throw the existing exported `RetainedLoginError`: `retained-rate-limit` has `.status === 429`; `retained-storage-capacity` has `.status === 503`. A custom retained adapter's legacy `bootstrap(false)` is treated as global storage pressure (503), not per-browser login capacity. Custom adapters need their own atomic implementation to provide admission; the interface alone cannot guarantee it.

Per-browser session capacity, pending capacity and context failures retain their existing 409 behavior. The pending store returns null for invalid context/proof or per-browser capacity, even during global pressure. Otherwise hard global storage pressure takes precedence over rate pressure; expired rows still count toward storage caps until cleanup. The built-in exchange/accounts routes, emailed code/link verification and Google OIDC/One Tap retained-error handlers use the new status. Browser capacity/context redirects remain unchanged; global pressure returns no-store JSON with 429/503 instead of redirecting. Custom handlers should honor `RetainedLoginError.status`. No global refusal consumes email proof, increments code attempts, redeems a grant or changes an existing selection. Single-cookie mode and authentication without a retained handle are unchanged.

### Migration Constraint

Apply root migrations through `0004_retained_principals.sql`, then the additive optional track [retained admission migration], **before** deploying this D1 adapter to a retained-mode consumer. Merely applying the root migration directory does not apply this nested track. Use a separate migration history/track, or copy the file into the consumer's own ordered sequence under a unique filename. Do not point an existing root migration runner at the nested directory and reuse its history as though this were root `0001`. No existing data is rewritten; previously allocated rows count toward hard storage quotas, while rate counters start on the first allocation after rollout. The demo uses retained D1 and a root migration directory, so it too needs this track explicitly integrated before deployment. No production migration, environment or deployment action is part of this change. Consumers without retained mode need not apply it. Existing email atomicity still needs only the old tables, but calling the new adapter's allocation methods requires the admission table; there is no silent schema fallback.

### Admission Verification

- `test/retained-admission.test.ts` is the focused suite: real SQLite SQL, exact window boundaries/backward time, new handles/recreated adapters, concurrent allocations, gates/kinds, finite defaults/integer validation, all pressure mappings, complete database snapshots proving refusals preserve grant redemptions/email proof/selection, bounded row retention over 50 windows, and transaction failure injection at every allocation-batch statement.
- Trigger tests suppress browser/pending insertion, selection CAS, readiness, counter claim and debit finalization; collisions and injected faults must leave complete snapshots unchanged, including counters.
- Run `pnpm exec vitest run test/retained-admission.test.ts` for SQLite and `pnpm test:retained-runtime` for ephemeral local workerd/D1. The package script and CI include the admission suite alongside the existing retained-store/proof suites. All 164 runtime tests passed on integration. No production bindings or credentials are used.
- TFFP: before the implementation, the new-handle/recreated-adapter regression failed because a third bootstrap resolved true; after the implementation it rejects with 429. Logs: `tmp/retained-admission-before.log`, `tmp/retained-admission-http.log`.

[multiple logins]: multiple-logins-and-account-switching.md
[D1's transactional batch contract]: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
[retained admission migration]: ../migrations/retained-login/0001_admission.sql
