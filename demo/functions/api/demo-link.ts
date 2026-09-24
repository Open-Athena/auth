/**
 * The home page's two demo links, minted on click.
 *
 * They sit side by side to make one argument visually: a link that renders the
 * recipient's name and face is *uncomfortable to forward*, and a bare one costs
 * nothing to pass along. That difference is the whole social design of share
 * links, and it's easier to feel than to read.
 *
 * `GET /api/demo-link?named=1` mints and 302s to `/dashboard?key=…`, so the
 * page can show a link that simply works — no button first — while nothing is
 * minted for visitors who only read. Short-lived and unlimited-redeem: this is
 * a front door, not a secret.
 */
import { resolveAvatar } from '@open-athena/auth'
import { type Env, VIEW_SCOPE, gates } from '../_lib/gates.js'

interface Ctx {
  request: Request
  env: Env
}

const TTL_S = 60 * 60

export const onRequestGet = async ({ request, env }: Ctx): Promise<Response> => {
  const { viewGate } = gates(env, request)
  const named = new URL(request.url).searchParams.get('named') === '1'

  // A real face, resolved here once rather than in the recipient's browser on
  // every render. GitHub rather than Gravatar for the demo persona only because
  // `octocat` is guaranteed to resolve — an address without a Gravatar returns
  // null, and `<Avatar>` falls back to initials, which is correct but makes for
  // a worse demo of the feature.
  const avatar = named ? await resolveAvatar({ github: 'octocat' }).catch(() => null) : null

  const { token } = await viewGate.mint({
    // The memo is for whoever reads the admin table later; the *person* is
    // `subject`, and that is what the page greets.
    // The bare link carries *nothing*: no memo either, or `displayName` would
    // fall back to it and the contrast this page is making would evaporate.
    name: named ? 'demo link, named' : null,
    note: 'minted by the home page',
    subject: named ? { first: 'Mona', last: 'Octocat', ...(avatar ? { avatar } : {}) } : null,
    scopes: [VIEW_SCOPE],
    expiresAt: Math.floor(Date.now() / 1000) + TTL_S,
    createdBy: 'demo',
  })

  return new Response(null, {
    status: 302,
    headers: { location: `/dashboard?key=${token}`, 'cache-control': 'no-store' },
  })
}
