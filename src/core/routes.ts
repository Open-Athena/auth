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
import type { Auth, Subject } from './types.js'
import type { AllowEntry, AllowlistStore, AuditQuery } from './store.js'
import type { Gate, GrantEdit, ProfileInput } from './gate.js'
import { assetId } from './assets.js'
import { InvalidImageError, MAX_PREVIEW_AVATAR_BYTES, bytesToDataUri, parseAvatarRef } from './avatar.js'
import { cleanSubject, isEmailish } from './requests.js'
import { readCookie } from './session.js'
import { hashToken } from './tokens.js'
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
   * Backs the `<basePath>/allowed` admin CRUD (list/add/remove allowed emails);
   * without it those routes 501. This is only the *management* surface — an app
   * still opts the table into authorization separately, by putting
   * `allowlistPolicy(store)` in its `policy`. Kept apart on purpose: mounting an
   * editor should not silently change who gets in.
   */
  allowlist?: AllowlistStore
  /**
   * Backs `POST <basePath>/allowed/sync`: run the app's directory sync on
   * demand (`run` is typically `() => syncGroupsToAllowlist(store, …)` from
   * `@open-athena/auth/google-directory`). Gated by `adminScope` — the panel's
   * "Sync now" — or by `token` presented as `Authorization: Bearer …`, so a
   * scheduled GitHub Action can drive it with no session and a Pages app needs
   * no cron Worker. Without it the route 501s.
   */
  sync?: { run: () => Promise<unknown>; token?: string }
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
 * ref (see `parseAvatarRef`)/gravatar/clear avatar; multipart when the avatar is an uploaded
 * file (raw bytes don't ride JSON cleanly). A key that's *absent* leaves that
 * field unchanged; `avatar: null` clears it.
 */
async function readProfileInput(req: Request): Promise<ProfileInput> {
  const ct = req.headers.get('content-type') ?? ''
  if (ct.includes('multipart/form-data')) {
    const form = await req.formData().catch(() => null)
    if (!form) return {}
    const input: ProfileInput = {}
    if (form.has('name')) input.name = String(form.get('name'))
    const file = form.get('avatar')
    // A file part is a Blob at runtime; workers-types narrows `FormData.get` to
    // `string | null` in this build, so duck-type past it rather than trust it.
    if (file !== null && typeof file !== 'string') {
      input.avatar = { upload: new Uint8Array(await (file as unknown as Blob).arrayBuffer()) }
    } else if (form.has('avatarRef')) input.avatar = { ref: String(form.get('avatarRef')) }
    else if (form.get('avatarGravatar') === 'true') input.avatar = { gravatar: true }
    else if (form.has('avatar')) input.avatar = null // a string `avatar` field is the clear directive
    return input
  }
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return {}
  const input: ProfileInput = {}
  if ('name' in b) input.name = (b.name as string | null) ?? null
  if ('avatar' in b) input.avatar = normalizeAvatarJson(b.avatar)
  return input
}

/** Coerce a JSON `avatar` value to an `AvatarInput` (uploads are multipart-only). */
function normalizeAvatarJson(a: unknown): ProfileInput['avatar'] {
  if (a === null) return null
  if (!a || typeof a !== 'object') return undefined
  const o = a as Record<string, unknown>
  if (typeof o.ref === 'string') return { ref: o.ref }
  if (o.gravatar === true) return { gravatar: true }
  return undefined
}

/**
 * Make sure `email` holds at least `scopes` on the allowlist. An existing row
 * that already covers them is left alone (its source and note included); one
 * that doesn't is widened to the union and becomes `manual`, since a directory
 * sync would otherwise drop the scopes it never granted.
 */
export async function allowForLink(
  store: AllowlistStore,
  email: string,
  scopes: string[],
  { note, addedBy }: { note: string; addedBy: string | null },
): Promise<{ email: string; status: 'added' | 'widened' | 'already' }> {
  const existing = await store.lookup(email)
  if (existing && scopes.every(s => existing.includes(s))) return { email, status: 'already' }
  await store.put({
    email,
    scopes: existing ? [...existing, ...scopes.filter(s => !existing.includes(s))] : scopes,
    source: 'manual',
    note,
    addedBy,
    updatedAt: Math.floor(Date.now() / 1000),
  })
  return { email, status: existing ? 'widened' : 'added' }
}

export function authRoutes(gate: Gate, opts: RouteOptions = {}) {
  const {
    basePath = '/api/auth',
    adminScope = 'admin',
    audit,
    allowlist,
    sync,
    creatorOf = defaultCreator,
    scopeToCreator,
    honeypotField = 'website',
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
    // A stored `asset://<id>` avatar means nothing to a browser; every response
    // that carries one points it at `GET <basePath>/avatar/:id` instead.
    const served = <T extends string | null | undefined>(v: T): T => {
      const id = assetId(v)
      return (id ? `${basePath}/avatar/${id}` : v) as T
    }
    const present = <T extends { subject?: Subject | null }>(o: T): T =>
      o.subject?.avatar ? { ...o, subject: { ...o.subject, avatar: served(o.subject.avatar) } } : o

    // ---- public -------------------------------------------------------------

    if (rest === '/whoami' && method === 'GET') {
      if (auth) return json(present(gate.whoami(auth)))
      // A dead cookie (revoked or expired grant, delisted email) is cleared
      // here, where the browser asks "who am I" — but only when the cookie is
      // what failed: a bad `?key=`/`Bearer` beside a live cookie is not a
      // reason to log the browser out.
      const presented = req.headers.get('Authorization')?.startsWith('Bearer ') || url.searchParams.has('key')
      const stale = !presented && readCookie(req, gate.cookieName) !== null
      return json({ error: 'unauthenticated' }, 401, stale ? { 'set-cookie': gate.expireCookie(req) } : {})
    }

    if (rest === '/exchange' && method === 'POST') {
      const { token } = await body<{ token: string }>(req)
      if (!token) return json({ error: 'token required' }, 400)
      const res = await gate.redeem(token, req)
      if (!res.ok) return json({ error: 'invalid link', reason: res.reason }, 401)
      return json(present(gate.whoami(res.auth)), 200, { 'set-cookie': res.cookie })
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
      return json(p ? { name: p.name, avatar: served(p.avatar) } : null)
    }

    if (rest === '/profile' && method === 'PUT') {
      if (!auth) return json({ error: 'unauthenticated' }, 401)
      const res = await gate.putProfile(auth, await readProfileInput(req))
      if (!res.ok) {
        const status =
          res.reason === 'forbidden' ? 403 : res.reason === 'rate-limited' ? 429 : res.reason === 'unconfigured' ? 501 : 400
        return json({ error: res.reason, ...('detail' in res ? { detail: res.detail } : {}) }, status)
      }
      return json({ name: res.profile.name, avatar: served(res.profile.avatar) })
    }

    if (rest === '/request' && method === 'POST') {
      const input = await body<{ email: string; name: string; note: string } & Record<string, string>>(req)
      // A filled honeypot gets the same answer a human gets: no signal back to
      // the bot about what tripped, and no row to clean up.
      if (input[honeypotField]) return json({ status: 'pending' })
      if (!input.email) return json({ error: 'email required' }, 400)
      // `cleanSubject` caps and strips the name: it's an attacker-controlled
      // string destined for a table an admin reads, and for the subject an
      // approved grant greets them by.
      const res = await gate.requestAccess(
        {
          email: input.email,
          name: input.name,
          note: input.note,
          subject: cleanSubject({ name: input.name }),
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
        return json({ grants: (await gate.list({ includeRevoked, ...listFilter(a) })).map(present) })
      }

      if (seg.length === 1 && method === 'POST') {
        const b = await body<{
          name: string
          note: string
          email: string
          /** The recipient's name (`subject.name`); `name` is the link's admin-side label. */
          subjectName: string
          /**
           * Anything `parseAvatarRef` takes — a GitHub/Bluesky/Mastodon profile
           * or handle, an image URL, a `data:` URI (an upload, or a preview
           * handed back). Copied before minting; never stored as a link.
           * Absent: the recipient's Gravatar, if `email` has one. `null`: none.
           */
          avatar: string | null
          scopes: string[]
          maxRedeems: number | null
          expiresInS: number | null
          sessionTtlS: number | null
          expiryEndsSessions: boolean
          /**
           * Also put `email` on the allowlist with the link's scopes, so the
           * recipient can later sign in with Google or an emailed code, not
           * only through the link. Revoking the link doesn't remove the row.
           */
          allowlist: boolean
        }>(req)
        if (!b.scopes?.length) return json({ error: 'scopes required' }, 400)
        // Checked before minting, so a request that can't be honored in full
        // doesn't leave a link behind.
        const allowEmail = b.allowlist ? (b.email ?? '').trim().toLowerCase() : null
        if (allowEmail !== null) {
          if (!allowlist) return json({ error: 'allowlist not configured' }, 501)
          if (!isEmailish(allowEmail)) return json({ error: 'allowlist needs a valid email' }, 400)
        }
        // Unlike the request form, the supplier here is an admin, so an avatar
        // *is* accepted — and copied by `gate.mint`, so what lands in every
        // recipient's `<img src>` is our own bytes, not a third party's URL.
        const subject = cleanSubject({ name: b.subjectName })
        const recipient = b.email?.trim().toLowerCase()
        const avatar =
          b.avatar !== undefined
            ? b.avatar
            : recipient && isEmailish(recipient)
              ? ((await gate.copyAvatar({ kind: 'gravatar', email: recipient }).catch(() => null))?.value ?? null)
              : null
        let minted: Awaited<ReturnType<typeof gate.mint>>
        try {
          minted = await gate.mint({
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
        } catch (e) {
          if (e instanceof InvalidImageError) return json({ error: 'invalid avatar', detail: e.message }, 400)
          throw e
        }
        const { grant, token } = minted
        const allowed =
          allowEmail !== null && allowlist
            ? await allowForLink(allowlist, allowEmail, b.scopes, {
                note: b.name?.trim() ? `with link "${b.name.trim()}"` : 'with a share link',
                addedBy: a.kind === 'sso' ? a.email : creatorOf(a),
              })
            : null
        // The only time the raw token is ever visible.
        return json({ grant: present(grant), token, ...(allowed ? { allowed } : {}) })
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
        const b = await body<GrantEdit>(req)
        // Whitelisted, not spread: a PATCH body is admin-supplied but still
        // untrusted structure, and `scopes`/`createdBy` are not negotiable
        // after minting. The holder's face goes in as a ref, as at mint.
        const patch: GrantEdit = {}
        if ('name' in b) patch.name = b.name ?? null
        if ('note' in b) patch.note = b.note ?? null
        if ('expiresAt' in b) patch.expiresAt = b.expiresAt ?? null
        if ('maxRedeems' in b) patch.maxRedeems = b.maxRedeems ?? null
        if ('sessionTtlS' in b) patch.sessionTtlS = b.sessionTtlS ?? null
        if ('expiryEndsSessions' in b) patch.expiryEndsSessions = !!b.expiryEndsSessions
        if ('subjectName' in b) patch.subjectName = b.subjectName ?? null
        if ('avatar' in b) patch.avatar = b.avatar ?? null
        let grant: Awaited<ReturnType<typeof gate.update>>
        try {
          grant = await gate.update(id, patch)
        } catch (e) {
          if (e instanceof InvalidImageError) return json({ error: 'invalid avatar', detail: e.message }, 400)
          throw e
        }
        return grant ? json({ grant: present(grant) }) : json({ error: 'not found' }, 404)
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
        return json({ request: res.request, grant: present(res.grant), token: res.token })
      }

      if (id && seg[2] === 'deny' && method === 'POST') {
        const request = await gate.denyRequest(id, creatorOf(a))
        if (!request) return json({ error: 'no pending request with that id' }, 404)
        return json({ request })
      }
    }

    // The allowlist an SSO `policy` can consult: an admin manages "who is
    // allowed" as a table here, and (separately) an app wires `allowlistPolicy`
    // to enforce it. Hand-added rows are `source: 'manual'`; a directory sync
    // owns its own source and never touches these — so the panel and a `board@`
    // sync coexist in one table.
    if (seg[0] === 'allowed' && seg[1] === 'sync' && seg.length === 2 && method === 'POST') {
      // A bearer that matches `sync.token` stands in for an admin session (the
      // cron case). Compared as hashes so the check isn't a timing oracle.
      const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
      const byToken = !!sync?.token && !!bearer && (await hashToken(bearer)) === (await hashToken(sync.token))
      if (!byToken) {
        const a = await admin()
        if (a instanceof Response) return a
      }
      if (!sync) return json({ error: 'sync not configured' }, 501)
      try {
        return json({ ok: true, result: await sync.run() })
      } catch (e) {
        // The upstream directory is down or the credential is wrong: say so
        // rather than 500 — the previous membership stands until it works.
        return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502)
      }
    }

    if (seg[0] === 'allowed') {
      const a = await admin()
      if (a instanceof Response) return a
      if (!allowlist) return json({ error: 'allowlist not configured' }, 501)

      if (seg.length === 1 && method === 'GET') {
        return json({ allowed: await allowlist.list() })
      }

      if (seg.length === 1 && (method === 'POST' || method === 'PUT')) {
        const b = await body<{ email: string; scopes: string[]; note: string }>(req)
        const email = (b.email ?? '').trim().toLowerCase()
        if (!isEmailish(email)) return json({ error: 'valid email required' }, 400)
        if (!Array.isArray(b.scopes)) return json({ error: 'scopes must be an array' }, 400)
        const entry: AllowEntry = {
          email,
          scopes: b.scopes,
          source: 'manual',
          note: b.note?.trim() || null,
          addedBy: a.kind === 'sso' ? a.email : creatorOf(a),
          updatedAt: Math.floor(Date.now() / 1000),
        }
        await allowlist.put(entry)
        return json({ entry })
      }

      // The email rides the path (`/allowed/foo%40bar.com`), so decode it; it
      // arrives percent-encoded because `@` is reserved in a path segment.
      const email = seg[1] ? decodeURIComponent(seg[1]) : ''
      if (email && seg.length === 2 && method === 'DELETE') {
        return json({ ok: await allowlist.remove(email.toLowerCase()) })
      }
    }

    // Preview a face before committing to it: the mint form and
    // `ProfilePanel` both show it. Answers a `data:` URI the browser downscales
    // and hands back to the mint/profile write (re-validated there, not
    // trusted) — so resizing needs no server-side image codec. An
    // admin or SSO principal only — a share-link visitor has nothing to set, and
    // shouldn't get a server that fetches images on request.
    if (rest === '/avatar' && method === 'POST') {
      if (!auth) return json({ error: 'unauthenticated' }, 401)
      if (auth.kind !== 'sso' && !hasScope(auth, adminScope)) return json({ error: 'forbidden' }, 403)
      const b = await body<{ ref?: string; email?: string }>(req)
      try {
        const ref = b.ref?.trim()
          ? parseAvatarRef(b.ref)
          : b.email && isEmailish(b.email.trim())
            ? ({ kind: 'gravatar', email: b.email.trim() } as const)
            : null
        if (!ref) return json({ error: 'ref or email required' }, 400)
        // Not the storage cap: the browser downscales this before handing it
        // back, and the mint then holds it to the storage cap.
        // `allowSvg`: an SVG comes back for the browser to draw to pixels; the
        // write that stores a face never accepts one (see `FetchAvatarOptions`).
        const img = await gate.fetchAvatar(ref, { maxBytes: MAX_PREVIEW_AVATAR_BYTES, allowSvg: true })
        return json({ avatar: img ? bytesToDataUri(img.type, img.bytes) : null, source: img?.source ?? ref.kind })
      } catch (e) {
        if (e instanceof InvalidImageError) return json({ error: 'invalid avatar', detail: e.message }, 400)
        throw e
      }
    }

    // The bytes behind a stored `asset://` avatar, from our own origin. Any
    // session will do (the id is unguessable, and faces aren't secrets from
    // someone already let in); an anonymous request gets nothing.
    if (seg[0] === 'avatar' && seg.length === 2 && method === 'GET') {
      if (!auth) return json({ error: 'unauthenticated' }, 401)
      const asset = await gate.getAsset(seg[1]!)
      if (!asset) return json({ error: 'not found' }, 404)
      return new Response(asset.bytes, {
        headers: {
          'content-type': asset.type,
          // An id is never reused for different bytes: a new face is a new id.
          'cache-control': 'private, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'",
        },
      })
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
