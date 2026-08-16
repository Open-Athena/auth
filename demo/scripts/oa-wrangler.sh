#!/bin/bash
# wrangler against the Open Athena account. Ambient CF credentials are usually
# the personal account's (that's where watchy-www, mortgage-viz et al. live),
# but `oa.dev` and this demo belong to OA. Same convention as
# watchy/scripts/oa-wrangler.sh.
#
# Needs $CLOUDFLARE_ADMIN_TOKEN in the environment. Also the entrypoint for
# secrets: `./scripts/oa-wrangler.sh pages secret put SESSION_SECRET`.
set -euo pipefail
: "${CLOUDFLARE_ADMIN_TOKEN:?set CLOUDFLARE_ADMIN_TOKEN (OA account admin token)}"
export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_ADMIN_TOKEN"
export CLOUDFLARE_ACCOUNT_ID=74981a43be0de7712369306c7b19133d
cd "$(dirname "$0")/.."
exec npx wrangler "$@"
