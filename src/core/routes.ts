/**
 * A mountable `/api/auth/*` surface, so a consumer wires the gate up instead of
 * re-deriving watchy's `auth.ts` by hand. Returns `null` for paths it doesn't
 * own, so an app can fall through to its own router.
 *
 * Everything here is presentation-free JSON: the wall, the admin table and the
 * copy around them are per-app and get vendored, per share-links §6.
 */
import { type DecisionPageOptions, renderDecisionPage } from './decision-page.js'
import type { DecisionView } from './decisions.js'
import type { Auth } from './types.js'
import type { AuditQuery } from './store.js'
import type { Gate, ProfileInput } from './gate.js'
import { type AvatarSource, type ResolveAvatarOptions, isSafeAvatarUrl, resolveAvatar } from './avatar.js'
import { cleanSubject } from './requests.js'
import { type GrantPatch, hasScope } from './types.js'

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
  /** Replaces the built-in approve/deny page wholesale. */
  decisionPage?: (view: DecisionView, opts: DecisionPageOptions) => Response
  /** Shown in the approve/deny page's copy. */
  decisionAppName?: string
  /**
   * Enables `POST <basePath>/avatar`, which resolves a Gravatar/GitHub/explicit
   * avatar for the admin UI to preview *before* minting. Only ever fetches
   * gravatar.com and github.com, so it is not a general fetch proxy.
   *
   * Off by default: it makes an outbound request per call, which a deployment
   * should opt into rather than discover.
   */
  avatarLookup?: boolean | ResolveAvatarOptions
}

/**
 * Every response here is identity-shaped — who you are, which links are yours,
 * who asked for access — so none of it may be stored by anything between the
 * worker and the browser. Nothing caches these today (CF reports `DYNAMIC`),
 * but an identity endpoint a proxy *could* hand to the wrong person is a bad
 * thing to leave to heuristics when the fix is one header.
 */
const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data, null, 2) + '\n', {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  })

async function body<T>(req: Request): Promise<Partial<T>> {
  return (await req.json().catch(() => ({}))) as Partial<T>
}

/**
 * The decision page posts a real `<form>`, so this endpoint has to read
 * `application/x-www-form-urlencoded` as well as JSON — a mail client is not
 * going to send `fetch` with a JSON body.
 */
async function formOrJson(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get('content-type') ?? ''
  if (ct.includes('json')) return (await req.json().catch(() => ({}))) as Record<string, string>
  const form = await req.formData().catch(() => null)
  if (!form) return {}
  return Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]))
}

const defaultCreator = (auth: Auth): string => (auth.kind === 'sso' ? auth.email : `g:${auth.grant.id}`)

/**
 * Parse a `PUT /profile` body into a `ProfileInput`. JSON for name + a
 * url/github/gravatar/clear avatar; multipart when the avatar is an uploaded
 * file (raw bytes don't ride JSON cleanly). A key that's *absent* leaves that
 * field unchanged; `avatar: null` clears it.
 */
async function readProfileInput(req: Request): Promise<ProfileInput> {
  const ct = req.headers.get('content-type') ?? ''
  if (ct.includes('multipart/form-data')) {
    const form = await req.formData().catch(() => null)
    if (!form) return {}
    const input: ProfileInput = {}
    if (form.has('first')) input.first = String(form.get('first'))
    if (form.has('last')) input.last = String(form.get('last'))
    const file = form.get('avatar')
    // A file part is a Blob at runtime; workers-types narrows `FormData.get` to
    // `string | null` in this build, so duck-type past it rather than trust it.
    if (file !== null && typeof file !== 'string') {
      input.avatar = { upload: new Uint8Array(await (file as unknown as Blob).arrayBuffer()) }
    } else if (form.has('avatarUrl')) input.avatar = { url: String(form.get('avatarUrl')) }
    else if (form.has('avatarGithub')) input.avatar = { github: String(form.get('avatarGithub')) }
    else if (form.get('avatarGravatar') === 'true') input.avatar = { gravatar: true }
    else if (form.has('avatar')) input.avatar = null // a string `avatar` field is the clear directive
    return input
  }
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return {}
  const input: ProfileInput = {}
  if ('first' in b) input.first = (b.first as string | null) ?? null
  if ('last' in b) input.last = (b.last as string | null) ?? null
  if ('avatar' in b) input.avatar = normalizeAvatarJson(b.avatar)
  return input
}

/** Coerce a JSON `avatar` value to an `AvatarInput` (uploads are multipart-only). */
function normalizeAvatarJson(a: unknown): ProfileInput['avatar'] {
  if (a === null) return null
  if (!a || typeof a !== 'object') return undefined
  const o = a as Record<string, unknown>
  if (typeof o.url === 'string') return { url: o.url }
  if (typeof o.github === 'string') return { github: o.github }
  if (o.gravatar === true) return { gravatar: true }
  return undefined
}

export function authRoutes(gate: Gate, opts: RouteOptions = {}) {
  const {
    basePath = '/api/auth',
    adminScope = 'admin',
    audit,
    creatorOf = defaultCreator,
    scopeToCreator,
    honeypotField = 'website',
    avatarLookup = false,
    decisionPage,
    decisionAppName,
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

    // The signed-in principal's own profile (name + face). Self only — `GET`
    // never takes an email argument, `PUT` only ever writes the caller's row.
    // No admin scope: editing your own label is not an admin action.
    if (rest === '/profile' && method === 'GET') {
      if (!auth) return json({ error: 'unauthenticated' }, 401)
      const p = await gate.getProfile(auth)
      return json(p ? { first: p.first, last: p.last, avatar: p.avatar } : null)
    }

    if (rest === '/profile' && method === 'PUT') {
      if (!auth) return json({ error: 'unauthenticated' }, 401)
      const res = await gate.putProfile(auth, await readProfileInput(req))
      if (!res.ok) {
        const status =
          res.reason === 'forbidden' ? 403 : res.reason === 'rate-limited' ? 429 : res.reason === 'unconfigured' ? 501 : 400
        return json({ error: res.reason, ...('detail' in res ? { detail: res.detail } : {}) }, status)
      }
      return json({ first: res.profile.first, last: res.profile.last, avatar: res.profile.avatar })
    }

    if (rest === '/request' && method === 'POST') {
      const input = await body<{ email: string; name: string; first: string; last: string; note: string } & Record<string, string>>(req)
      // A filled honeypot gets the same answer a human gets: no signal back to
      // the bot about what tripped, and no row to clean up.
      if (input[honeypotField]) return json({ status: 'pending' })
      if (!input.email) return json({ error: 'email required' }, 400)
      // `cleanSubject` caps and strips these: they are attacker-controlled
      // strings destined for a table an admin reads.
      const res = await gate.requestAccess(
        {
          email: input.email,
          name: input.name,
          note: input.note,
          subject: cleanSubject({ first: input.first, last: input.last }),
        },
        req,
      )
      if (res.status === 'invalid') return json({ status: 'invalid', error: "that doesn't look like an email address" }, 400)
      if (res.status === 'rate-limited') return json({ status: 'rate-limited', error: 'too many requests; try later' }, 429)
      // Never echo the request id or token back to an unauthenticated submitter.
      return json({ status: res.status })
    }

    // Decision links, reached from a mail client. GET renders a confirmation
    // page and commits nothing — mail scanners (Outlook Safe Links, corporate
    // gateways, antivirus) fetch every URL in a message, and a GET that decided
    // would let them approve requests in an admin's name. POST commits.
    if (rest === '/decide' && (method === 'GET' || method === 'POST')) {
      const token =
        method === 'GET' ? (url.searchParams.get('t') ?? '') : ((await formOrJson(req)).t ?? '')
      const view = await gate.decide(token, {
        commit: method === 'POST',
        // Only ever an authenticated admin; `requireAuth` decides whether the
        // absence of one is fatal.
        actor: auth && hasScope(auth, adminScope) && auth.kind === 'sso' ? auth.email : null,
      })
      const render = decisionPage ?? renderDecisionPage
      return render(view, { appName: decisionAppName, action: `${basePath}/decide` })
    }

    // ---- admin --------------------------------------------------------------

    if (seg[0] === 'grants') {
      const a = await admin()
      if (a instanceof Response) return a

      if (seg.length === 1 && method === 'GET') {
        // Revoked grants stay in the list by default: this is the ledger an
        // admin reads, and a row vanishing on revoke is indistinguishable from
        // a delete — it hides exactly the history revocation is evidence of.
        // `?active=1` opts out. (The *store* still defaults to active-only,
        // which is the right default for a gate check.)
        const includeRevoked = url.searchParams.get('active') !== '1'
        return json({ grants: await gate.list({ includeRevoked, ...listFilter(a) }) })
      }

      if (seg.length === 1 && method === 'POST') {
        const b = await body<{
          name: string
          note: string
          email: string
          first: string
          last: string
          avatar: string
          scopes: string[]
          maxRedeems: number | null
          expiresInS: number | null
          sessionTtlS: number | null
          expiryEndsSessions: boolean
        }>(req)
        if (!b.scopes?.length) return json({ error: 'scopes required' }, 400)
        // Unlike the request form, the supplier here is an admin, so an avatar
        // *is* accepted — still `https:`-only, since the value lands in an
        // `<img src>` on every recipient's page.
        const subject = cleanSubject({ first: b.first, last: b.last })
        const avatar = b.avatar && isSafeAvatarUrl(b.avatar) ? b.avatar : null
        const { grant, token } = await gate.mint({
          name: b.name ?? null,
          note: b.note ?? null,
          email: b.email ?? null,
          subject: avatar ? { ...subject, avatar } : subject,
          scopes: b.scopes,
          maxRedeems: b.maxRedeems ?? null,
          expiresAt: b.expiresInS ? Math.floor(Date.now() / 1000) + b.expiresInS : null,
          sessionTtlS: b.sessionTtlS ?? null,
          expiryEndsSessions: b.expiryEndsSessions ?? true,
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

      // Re-key a leaked link without losing its subject/scopes/expiry. Body
      // `{ endSessions: true }` also boots sessions minted from the old link.
      if (id && seg[2] === 'rotate' && method === 'POST') {
        const owned = await ownedGrant(id, a)
        if (owned instanceof Response) return owned
        const b = await body<{ endSessions?: boolean }>(req)
        const res = await gate.rotate(id, { endSessions: !!b.endSessions })
        // The only time the re-keyed raw token is ever visible.
        return res ? json({ id, token: res.token }) : json({ error: 'not found' }, 404)
      }

      // Disable/enable are the reversible half: they stop new redemptions and
      // leave anyone already reading the page alone.
      if (id && (seg[2] === 'disable' || seg[2] === 'enable') && method === 'POST') {
        const owned = await ownedGrant(id, a)
        if (owned instanceof Response) return owned
        return json({ ok: seg[2] === 'disable' ? await gate.disable(id) : await gate.enable(id) })
      }

      if (id && seg.length === 2 && method === 'PATCH') {
        const owned = await ownedGrant(id, a)
        if (owned instanceof Response) return owned
        const b = await body<GrantPatch>(req)
        // Whitelisted, not spread: a PATCH body is admin-supplied but still
        // untrusted structure, and `scopes`/`createdBy` are not negotiable
        // after minting.
        const patch: GrantPatch = {}
        if ('name' in b) patch.name = b.name ?? null
        if ('note' in b) patch.note = b.note ?? null
        if ('expiresAt' in b) patch.expiresAt = b.expiresAt ?? null
        if ('maxRedeems' in b) patch.maxRedeems = b.maxRedeems ?? null
        if ('sessionTtlS' in b) patch.sessionTtlS = b.sessionTtlS ?? null
        if ('expiryEndsSessions' in b) patch.expiryEndsSessions = !!b.expiryEndsSessions
        const grant = await gate.update(id, patch)
        return grant ? json({ grant }) : json({ error: 'not found' }, 404)
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

    if (rest === '/avatar' && method === 'POST') {
      const a = await admin()
      if (a instanceof Response) return a
      if (!avatarLookup) return json({ error: 'avatar lookup not configured' }, 501)
      const b = await body<AvatarSource>(req)
      const opts = typeof avatarLookup === 'object' ? avatarLookup : {}
      return json({ avatar: await resolveAvatar({ email: b.email, github: b.github, url: b.url }, opts) })
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
