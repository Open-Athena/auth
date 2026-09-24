#!/bin/sh
# Point wrangler at the package's *numbered* migrations only.
#
# `migrations_dir` used to be `../migrations` directly, but that directory also
# holds `schema.sql` (the whole schema in one file, for fresh installs), and
# wrangler applies every `.sql` it finds in order — so after `0012_*` it tries
# `schema.sql` and dies on `table grants already exists`. Symlinks keep the
# demo on the package's schema without a copy that could drift; re-run on
# every `db:*` so a new numbered migration is picked up (and shows up in
# `git status`, as a reminder to commit the link).
set -eu
cd "$(dirname "$0")/.."
mkdir -p migrations
for f in ../migrations/[0-9]*.sql; do
  ln -sf "../$f" "migrations/$(basename "$f")"
done
