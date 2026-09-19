# `dist` branch ships stale `migrations/` (0006, 0007 missing)

Found 2026-09-06 adopting `@open-athena/auth` in disk-tree (`~/c/disk-tree/specs/pages-auth.md`), pinned at the current `dist` tip `43bf9598…` (`0.1.0-dist.9809e57`, built from source `9809e57`, 2026-08-24).

The package's `dist/adapters/d1.js` selects `disabled_at` (5 references) and `subject_json` (6), i.e. it needs `0007_disable_and_expiry_policy.sql` (source commit `d886126`, 2026-08-21) and `0006_request_subject.sql` (`e41150e`, 2026-08-18) — but the dist branch's `migrations/` holds only `0001`–`0005`. A fresh consumer that copies `node_modules/@open-athena/auth/migrations/*.sql` (as the README's "byte-identical copies" model suggests) and applies them gets `D1_ERROR: no such column: disabled_at` on the first `GET /api/auth/grants`.

Workaround used: copied `0006`/`0007` from this source clone into `disk-tree/ui/migrations/`.

Ask: make the dist publish carry the full `migrations/` dir at the built commit (or fail the publish when `dist/` references a column no shipped migration creates — `scripts/verify-dist.mjs` could grep the adapter for column names and check each appears in some migration). Worth a test either way: the exact failure a consumer sees is one `SELECT` away.

## Resolution (2026-09-18)

Root cause was a hand-kept file list in two places, drifting from the actual `migrations/` dir. `test/d1-shim.ts` *discovers* migrations from the dir ("discovered not listed"), so the source suite always ran the complete schema and never saw the gap — it existed only in the packaging path.

Fixed both, so the set can no longer drift:

- **`.github/workflows/ci.yml`** — `extra_files` now ships the whole `migrations` directory instead of five named files. `runsascoded/npm-dist`'s `build-dist.sh` `cp -r`s a directory entry (`extra_files` handling, `elif [ -d "$file" ]`), so a migration added later travels automatically.
- **`scripts/verify-dist.mjs`** — replaced the hardcoded `['0001'…'0005']` list (and its `length === 5` assertion) with a check that the **installed package's** `migrations/*.sql` set exactly equals the **source** set (`migrations match source`), plus the existing `CREATE TABLE grants` sanity check on `0001`. Set-equality was chosen over the spec's alternative column-grep: it's exact rather than heuristic, and it's strictly stronger for *this* bug (a shipped-vs-source difference is the failure), while the source suite (`test/d1.test.ts` over the discovered schema) already proves the adapter's columns all exist in the complete set. So `verify-dist` now fails the publish on any divergence — the guard runs post-`dist`-build, exactly where the drift occurred.

No source (`src/`) change was needed; the bug was entirely in CI config + the verify tooling.
