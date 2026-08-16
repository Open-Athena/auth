/**
 * A mountable `/api/auth/*` surface, so a consumer wires the gate up instead of
 * re-deriving watchy's `auth.ts` by hand. Returns `null` for paths it doesn't
 * own, so an app can fall through to its own router.
 *
 * Everything here is presentation-free JSON: the wall, the admin table and the
 * copy around them are per-app and get vendored, per share-links §6.
 */
import type { Auth } from './types.js'
import type { AuditQuery } from './store.js'
import type { Gate } from './gate.js'
import { hasScope } from './types.js'

export interface RouteOptions {
  /** Default `/api/auth`. */
  basePath?: string
  /** Scope required for the admin routes. Default `admin` (the wildcard `*` satisfies it). */
  adminScope?: string
  /**
   * Scope required to see and decide access requests. Defaults to `adminScope`.
   * Worth separating: minting a share link affects only your own links, while
   * the request queue holds other people's email addresses.
   */
  requestScope?: string
  /** Read side of the access log; without it the activity/log routes 501. */
  audit?: AuditQuery
  /**
   * The identity recorded as a grant's `created_by`. Default: the SSO email.
   * Returning a per-visitor value plus `scopeToCreator` gives each admin their
   * own sandbox of links — which is how the demo lets strangers try the admin
   * side without seeing (or revoking) anyone else's.
   */
  creatorOf?: (auth: Auth) => string
  /** When set, admin reads and writes are confined to grants this identity created. */
  scopeToCreator?: (auth: Auth) => string | undefined
  /** Hidden form field that only a bot fills in. Default `website`. */
  honeypotField?: string
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data, null, 2) + '\n', {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })

async function body<T>(req: Request): Promise<Partial<T>> {
  return (await req.json().catch(() => ({}))) as Partial<T>
}

const defaultCreator = (auth: Auth): string => (auth.kind === 'sso' ? auth.email : `g:${auth.grant.id}`)

export function authRoutes(gate: Gate, opts: RouteOptions = {}) {
  const {
    basePath = '/api/auth',
    adminScope = 'admin',
    audit,
    creatorOf = defaultCreator,
    scopeToCreator,
    honeypotField = 'website',
  } = opts

  return async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url)
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return null
    const rest = url.pathname.slice(basePath.length) || '/'
    const method = req.method
    const seg = rest.split('/').filter(Boolean)

    // Resolve identity once per request; admin routes then re-check the scope.
    // `logView: false` because these endpoints are plumbing, not pages — a view
    // row per `/whoami` poll would bury the routes a visitor actually read.
    const auth = await gate.authenticate(req, undefined, { logView: false })
    const require = async (scope: string): Promise<Auth | Response> => {
      if (!auth) return json({ error: 'unauthenticated' }, 401)
      if (!hasScope(auth, scope)) return json({ error: 'forbidden' }, 403)
      return auth
    }
    const admin = () => require(adminScope)
    const listFilter = (a: Auth) => (scopeToCreator ? { createdBy: scopeToCreator(a) } : {})

    // ---- public -------------------------------------------------------------

    if (rest === '/whoami' && method === 'GET') {
      return auth ? json(gate.whoami(auth)) : json({ error: 'unauthenticated' }, 401)
    }

    if (rest === '/exchange' && method === 'POST') {
      const { token } = await body<{ token: string }>(req)
      if (!token) return json({ error: 'token required' }, 400)
      const res = await gate.redeem(token, req)
      if (!res.ok) return json({ error: 'invalid link', reason: res.reason }, 401)
      return json(gate.whoami(res.auth), 200, { 'set-cookie': res.cookie })
    }

    if (rest === '/logout' && method === 'POST') {
      return json({ ok: true }, 200, { 'set-cookie': await gate.signOut(req, auth) })
    }

    /**
     * First-party beacon for client-only signals — SPA route changes above all,
     * which no server request would otherwise reveal. Same store as everything
     * else, so "who viewed what" still joins to `grants` natively; no
     * third-party script, and no cookie banner, since the only cookie involved
     * is the session the visitor already has.
     */
    if (rest === '/track' && method === 'POST') {
      if (!auth) return json({ ok: true }) // anonymous beacons are simply dropped
      const { path } = await body<{ path: string }>(req)
      // A client-supplied path is untrusted input that lands in an admin's
      // table: take same-origin paths only, and cap the length.
      if (!path || !path.startsWith('/') || path.startsWith('//') || path.length > 512) {
        return json({ error: 'path must be a same-origin path' }, 400)
      }
      await gate.logView(req, auth, undefined, path)
      return json({ ok: true })
    }

    if (rest === '/request' && method === 'POST') {
      const input = await body<{ email: string; name: string; note: string } & Record<string, string>>(req)
      // A filled honeypot gets the same answer a human gets: no signal back to
      // the bot about what tripped, and no row to clean up.
      if (input[honeypotField]) return json({ status: 'pending' })
      if (!input.email) return json({ error: 'email required' }, 400)
      const res = await gate.requestAccess({ email: input.email, name: input.name, note: input.note }, req)
      if (res.status === 'invalid') return json({ status: 'invalid', error: "that doesn't look like an email address" }, 400)
      if (res.status === 'rate-limited') return json({ status: 'rate-limited', error: 'too many requests; try later' }, 429)
      // Never echo the request id or token back to an unauthenticated submitter.
      return json({ status: res.status })
    }

    // ---- admin --------------------------------------------------------------

    if (seg[0] === 'grants') {
      const a = await admin()
      if (a instanceof Response) return a

      if (seg.length === 1 && method === 'GET') {
        const includeRevoked = url.searchParams.get('all') === '1'
        return json({ grants: await gate.list({ includeRevoked, ...listFilter(a) }) })
      }

      if (seg.length === 1 && method === 'POST') {
        const b = await body<{
          name: string
          note: string
          email: string
          scopes: string[]
          maxRedeems: number | null
          expiresInS: number | null
          sessionTtlS: number | null
        }>(req)
        if (!b.scopes?.length) return json({ error: 'scopes required' }, 400)
        const { grant, token } = await gate.mint({
          name: b.name ?? null,
          note: b.note ?? null,
          email: b.email ?? null,
          scopes: b.scopes,
          maxRedeems: b.maxRedeems ?? null,
          expiresAt: b.expiresInS ? Math.floor(Date.now() / 1000) + b.expiresInS : null,
          sessionTtlS: b.sessionTtlS ?? null,
          createdBy: creatorOf(a),
        })
        // The only time the raw token is ever visible.
        return json({ grant, token })
      }

      const id = seg[1]
      if (id && seg[2] === 'revoke' && method === 'POST') {
        const owned = await ownedGrant(id, a)
        if (owned instanceof Response) return owned
        return json({ ok: await gate.revoke(id) })
      }

      if (id && seg[2] === 'activity' && method === 'GET') {
        if (!audit) return json({ error: 'audit query not configured' }, 501)
        const owned = await ownedGrant(id, a)
        if (owned instanceof Response) return owned
        return json(await audit.activity(id))
      }
    }

    if (seg[0] === 'requests') {
      const a = await require(opts.requestScope ?? adminScope)
      if (a instanceof Response) return a

      if (seg.length === 1 && method === 'GET') {
        const status = url.searchParams.get('status') as 'pending' | null
        return json({ requests: await gate.listRequests(status ? { status } : undefined) })
      }

      const id = seg[1]
      if (id && seg[2] === 'approve' && method === 'POST') {
        const b = await body<{ scopes: string[] }>(req)
        const res = await gate.approveRequest(id, creatorOf(a), { scopes: b.scopes })
        if (!res) return json({ error: 'no pending request with that id' }, 404)
        return json({ request: res.request, grant: res.grant, token: res.token })
      }

      if (id && seg[2] === 'deny' && method === 'POST') {
        const request = await gate.denyRequest(id, creatorOf(a))
        if (!request) return json({ error: 'no pending request with that id' }, 404)
        return json({ request })
      }
    }

    if (rest === '/log' && method === 'GET') {
      const a = await admin()
      if (a instanceof Response) return a
      if (!audit) return json({ error: 'audit query not configured' }, 501)
      const grantId = url.searchParams.get('grant') ?? undefined
      const limit = Number(url.searchParams.get('limit')) || 100
      return json({ events: await audit.recent({ grantId, limit, ...listFilter(a) }) })
    }

    return json({ error: 'not found' }, 404)

    /** 404 (not 403) for someone else's grant: don't confirm that an id exists. */
    async function ownedGrant(id: string, a: Auth): Promise<true | Response> {
      if (!scopeToCreator) return true
      const mine = await gate.list({ includeRevoked: true, createdBy: scopeToCreator(a) })
      return mine.some(g => g.id === id) ? true : json({ error: 'not found' }, 404)
    }
  }
}
