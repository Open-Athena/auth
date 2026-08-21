/**
 * Hand a visitor an ephemeral identity so they can try the *admin* side —
 * minting links, watching the log, revoking — without an account and without
 * seeing anyone else's links (the routes filter every read and write by
 * `created_by`, which is this identity).
 *
 * It grants `admin` only, not `reports`: a sandbox owner still meets the wall
 * on the dashboard, and has to mint themselves a link to get through it. That's
 * the demo, not an oversight.
 */
import { type Env, SANDBOX_DOMAIN, gates, json } from '../_lib/gates.js'

interface Ctx {
  request: Request
  env: Env
}

/**
 * Two words, Docker-style. An identity called `brave-otter` is obviously not a
 * real account, which does the work a paragraph of explanation was doing: you
 * can see you're in a sandbox without being told.
 */
const ADJECTIVES = [
  'amber', 'brave', 'calm', 'clever', 'dusty', 'eager', 'fuzzy', 'gentle', 'happy', 'jolly',
  'keen', 'lucky', 'mellow', 'nimble', 'plucky', 'quiet', 'rapid', 'sunny', 'tidy', 'witty',
]
const NOUNS = [
  'otter', 'falcon', 'maple', 'harbor', 'lantern', 'meadow', 'compass', 'pebble', 'quill', 'ridge',
  'sparrow', 'thistle', 'walnut', 'willow', 'badger', 'cedar', 'ferry', 'grotto', 'heron', 'juniper',
]

const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!

/** Resume an existing sandbox if one is passed, so a redeemed link doesn't strand it. */
const idFor = (existing: string | null): string =>
  existing && /^[a-z]{3,10}-[a-z]{3,10}$/.test(existing) ? existing : `${pick(ADJECTIVES)}-${pick(NOUNS)}`

export const onRequestPost = async ({ request, env }: Ctx): Promise<Response> => {
  const { adminGate } = gates(env, request)
  const { id } = (await request.json().catch(() => ({}))) as { id?: string }
  const email = `demo-${idFor(id ?? null)}@${SANDBOX_DOMAIN}`
  const signedIn = await adminGate.signIn(email, request)
  if (!signedIn) return json({ error: 'sandbox policy rejected the identity' }, 500)
  return json({ id: email.slice('demo-'.length, -`@${SANDBOX_DOMAIN}`.length), email }, 200, {
    'set-cookie': signedIn.cookie,
  })
}
