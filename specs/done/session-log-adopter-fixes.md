# Session Log Adopter Fixes

Status (2026-11-09): implemented and verified. Public `/session-log/model` is framework-free; logger/server/viewer share cancellation semantics; anonymous config reads do not perform retention. No production logging settings or schema changed. Package publication is gated on CI and artifact verification; Disky removes its downstream patch only after adopting the verified pin.

Requested by Disky's shared-logger adoption and selected by Ryan on 2026-11-09. Upstream the behavior fixes currently carried in Disky's frozen-install patch, then publish a verified replacement pin so the adopter can remove its patch without losing coverage. Do not edit or deploy Disky itself.

## Scope

Explicit AbortError requests are cancellation, not application errors. Fetch failures that precede pagehide by at most five seconds are classified as navigation cancellations; failures on a surviving page remain real errors. This is a client-side heuristic, not proof that backend operations were cancelled. Preserve the original fetch resolution/rejection and request timestamp, bound held failures, clear timers on uninstall, and beacon the classified events on pagehide.

Filter benign ResizeObserver scheduling reports without hiding unrelated failures. Anonymous session-log config reads, including opted-in public viewers, must not run retention writes; a signed-in viewer still performs bounded maintenance. Export the existing framework-free timeline model as `/session-log/model`, without importing React, and preserve Disky's compact duration/offset formatting.

## Acceptance

Use exact assertions for cancellation summaries/error counts, delayed real failures, pagehide classification, benign reports, maintenance authorization and public model imports. Seven new regressions failed before applying the fixes. Update older clock/format expectations only for the intentional behavior changes. Verify the emitted artifact, browser behavior and source/D1 tests; supply Disky an immutable verified pin. No database migrations or live logging-switch changes belong to this fix.

Integration verification: 1,311 unit/component tests passed (three opt-in runtime cases skipped in that run); all 164 local workerd/D1 retained tests passed separately. Typechecking and build passed. The new Playwright test uses actual session-log routes and the D1 shim behind the rendered demo, checks cancellation/error filters and day formatting on desktop dark/light and mobile, and passes all three projects. Screenshot inspection also caught narrow mobile event columns; the optional stylesheet now keeps a readable timeline with horizontal overflow confined to its existing scroll container. Chrome MCP was unavailable because its profile was occupied, so browser verification used Playwright, not the user's OA Chrome.
