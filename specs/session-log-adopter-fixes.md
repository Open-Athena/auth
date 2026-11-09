# Session Log Adopter Fixes

Requested by Disky's shared-logger adoption and selected by Ryan on 2026-11-09. Upstream the behavior fixes currently carried in Disky's frozen-install patch, then publish a verified replacement pin so the adopter can remove its patch without losing coverage. Do not edit or deploy Disky itself.

## Scope

Explicit AbortError requests are cancellation, not application errors. Fetch failures that precede pagehide by at most five seconds are classified as navigation cancellations; failures on a surviving page remain real errors. This is a client-side heuristic, not proof that backend operations were cancelled. Preserve the original fetch resolution/rejection and request timestamp, bound held failures, clear timers on uninstall, and beacon the classified events on pagehide.

Filter benign ResizeObserver scheduling reports without hiding unrelated failures. Anonymous session-log config reads, including opted-in public viewers, must not run retention writes; a signed-in viewer still performs bounded maintenance. Export the existing framework-free timeline model as `/session-log/model`, without importing React, and preserve Disky's compact duration/offset formatting.

## Acceptance

Use exact assertions for cancellation summaries/error counts, delayed real failures, pagehide classification, benign reports, maintenance authorization and public model imports. Seven new regressions failed before applying the fixes. Update older clock/format expectations only for the intentional behavior changes. Verify the emitted artifact, browser behavior and source/D1 tests; supply Disky an immutable verified pin. No database migrations or live logging-switch changes belong to this fix.
