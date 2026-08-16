/**
 * The gated data — stand-in for the sensitive dashboard everyone in the consumer
 * map is actually protecting. Note what runs here: one `authenticate()` call,
 * one scope check. Because grant-backed sessions re-join their grant row on
 * every request, a link revoked a second ago fails *this* fetch.
 */
import { hasScope } from '@open-athena/auth'
import { type Env, VIEW_SCOPE, gates, json } from '../../_lib/gates.js'

interface Ctx {
  request: Request
  env: Env
}

/** Invented figures. Sensitive-*shaped*, so the demo reads like the real thing. */
const SUMMARY = {
  title: 'FY2025 giving summary',
  updated: '2026-08-14',
  totals: { committed: 4_820_000, received: 3_115_000, pledged: 1_705_000 },
  funds: [
    { name: 'General operating', committed: 2_100_000, received: 1_680_000 },
    { name: 'Fellowship endowment', committed: 1_450_000, received: 890_000 },
    { name: 'Compute grants', committed: 1_270_000, received: 545_000 },
  ],
  donors: [
    { name: 'Anonymous (Bay Area)', amount: 1_000_000, status: 'received' },
    { name: 'Halvorsen Family Trust', amount: 750_000, status: 'pledged' },
    { name: 'Ridgeline Foundation', amount: 620_000, status: 'received' },
    { name: 'K. Osei', amount: 410_000, status: 'received' },
    { name: 'Meridian Fund', amount: 335_000, status: 'pledged' },
  ],
}

export const onRequest = async ({ request, env }: Ctx): Promise<Response> => {
  const { viewGate } = gates(env, request)
  const auth = await viewGate.authenticate(request)
  if (!auth) return json({ error: 'unauthenticated' }, 401)
  if (!hasScope(auth, VIEW_SCOPE)) return json({ error: 'forbidden' }, 403)
  return json(SUMMARY)
}
