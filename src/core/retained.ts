/**
 * A gate's opt-in retained-login mode: one browser can hold several logins
 * (verified email sign-ins and share-link sessions) and switch between them
 * without signing in again. Each request acts as exactly one of them, the
 * active selection; nothing is ever the union of their scopes.
 *
 * The browser holds one opaque HttpOnly handle cookie (never a roster, never
 * an identity); the store keys its browser set by a keyed hash of it. Every
 * change to the set (adding, switching, removing, an incoming link) bumps the
 * set's version, and the mutations take the version the client last saw
 * (`X-OA-Selection-Context`), so a form opened as A can't submit as B after
 * another tab switched.
 *
 * Off unless a gate is given `retained`; the single-cookie path is unchanged.
 */
import { b64uEncode } from './base64.js'
import type { AccountView, AccountsResponse, IncomingView } from './http.js'
import { clearCookie, emailSub, grantSub, inspectSessionClaims, isSecureRequest, readCookie } from './session.js'
import type { RetainedBinding, RetainedBrowser, RetainedSession, RetainedStore } from './retained-store.js'
import { SELECTION_CONTEXT_HEADER, type SelectionContext, parseSelectionContext, serializeSelectionContext } from './selection-context.js'
import type { Auth, Grant } from './types.js'
import { generateId } from './tokens.js'

/** What an incoming share link does while another login is active. */
export type IncomingDecision = 'keep' | 'switch'
export type IncomingPolicy =
  | IncomingDecision
  | ((c: { active: Auth; incoming: Grant; req: Request }) => IncomingDecision | Promise<IncomingDecision>)

export interface RetainedOptions {
  /** `d1RetainedStore(db, limits)`, on the same database as the grants. */
  store: RetainedStore
  /** Distinguishes this gate's browser sets in a shared store (default: the gate's cookie name). */
  gateId?: string
  /** The handle cookie (default `<gate cookie>_rs`). */
  cookieName?: string
  /**
   * An incoming share link while a login is active: `'keep'` (the default)
   * stays as the current login and offers the link as an account to switch
   * to, spending no redemption; `'switch'` changes to it; a function decides
   * per link. With no active login, a valid link always signs in.
   */
  incoming?: IncomingPolicy
}

/** A retained-mode refusal the routes answer with 409. */
export class RetainedLoginError extends Error {
  constructor(
    readonly code:
      | 'retained-login-capacity'
      | 'pending-link-capacity'
      | 'selection_context_conflict'
      /** A held link that can't become a login now: the browser is full, the link used up, or the offer lapsed. */
      | 'incoming-unavailable',
  ) {
    super(code)
    this.name = 'RetainedLoginError'
  }
}

/** The gate's side of a retained login: turn a principal into a live identity (or not). */
export type ResolveSub = (
  req: Request,
  claims: { sub: string; iat: number },
  nowS: number,
  opts: { quiet: boolean; logView: boolean },
) => Promise<{ auth: Auth | null; reason: import('./denial.js').SessionLossReason | null }>

interface Deps {
  secret: string
  gateCookie: string
  sessionTtlS: number
  resolve: ResolveSub
  grantById: (id: string) => Promise<Grant | null>
}

/** A browser's set and the binding that proves this request holds its handle. */
interface Held {
  binding: RetainedBinding
  browser: RetainedBrowser
}

const enc = new TextEncoder()

export function retainedMode(opts: RetainedOptions, deps: Deps) {
  const { store, incoming = 'keep' } = opts
  const gateId = opts.gateId ?? deps.gateCookie
  const handleCookie = opts.cookieName ?? `${deps.gateCookie}_rs`

  async function handleHash(handle: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', enc.encode(deps.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    return b64uEncode(await crypto.subtle.sign('HMAC', key, enc.encode(`oa-retained:${gateId}:${handle}`)))
  }

  const sec = (ms: number) => Math.floor(ms / 1000)
  const cookieAttrs = (req: Request, maxAge: number) =>
    `HttpOnly;${isSecureRequest(req) ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=${maxAge}`
  const handleSetCookie = (req: Request, handle: string, browser: RetainedBrowser, nowS: number) =>
    `${handleCookie}=${handle}; ${cookieAttrs(req, Math.max(0, browser.expiresAt - nowS))}`
  const clearHandle = (req: Request) => `${handleCookie}=; ${cookieAttrs(req, 0)}`
  const clearLegacy = (req: Request) => clearCookie({ name: deps.gateCookie, secure: isSecureRequest(req) })

  /** The live set this request's handle names, or null (no handle, or a dead one). */
  async function held(req: Request, nowS: number): Promise<Held | null> {
    const handle = readCookie(req, handleCookie)
    if (!handle) return null
    const hash = await handleHash(handle)
    const browser = await store.browser({ gateId, handleHash: hash }, nowS)
    return browser ? { browser, binding: { gateId, browserSetId: browser.browserSetId, handleHash: hash } } : null
  }

  const contextOf = (b: RetainedBrowser): SelectionContext => ({
    browserSetId: b.browserSetId,
    sessionId: b.activeSessionId,
    version: b.version,
  })

  /**
   * This request's set, creating one if it has none. A new set imports a
   * still-valid single-session cookie once (its `iat` and `exp` kept, never
   * extended), so turning retention on doesn't sign anyone out; the response
   * then clears that cookie, and from then on it is ignored.
   */
  async function ensure(req: Request, nowMs: number): Promise<{ h: Held; cookies: string[] }> {
    const nowS = sec(nowMs)
    const existing = await held(req, nowS)
    const legacy = readCookie(req, deps.gateCookie)
    const cookies: string[] = legacy !== null ? [clearLegacy(req)] : []
    if (existing) {
      const handle = readCookie(req, handleCookie)!
      return { h: existing, cookies: [handleSetCookie(req, handle, existing.browser, nowS), ...cookies] }
    }
    const handle = b64uEncode(crypto.getRandomValues(new Uint8Array(32)))
    const binding: RetainedBinding = { gateId, browserSetId: generateId(), handleHash: await handleHash(handle) }
    if (!(await store.bootstrap(binding, nowS))) throw new RetainedLoginError('retained-login-capacity')
    let browser = (await store.browser(binding, nowS))!
    if (legacy !== null) {
      const claims = await inspectSessionClaims(legacy, deps.secret, nowMs)
      if (claims.ok) {
        const { auth } = await deps.resolve(req, claims.claims, nowS, { quiet: true, logView: false })
        if (auth) {
          const ctx = await store.addSession(
            {
              ...binding,
              expected: contextOf(browser),
              sessionId: generateId(),
              sub: claims.claims.sub,
              issuedAt: claims.claims.iat,
              expiresAt: claims.claims.exp,
              select: true,
            },
            nowS,
          )
          if (ctx) browser = (await store.browser(binding, nowS))!
        }
      }
    }
    return { h: { binding, browser }, cookies: [handleSetCookie(req, handle, browser, nowS), ...cookies] }
  }

  /** The active login's identity, or why there is none (`reason` null = signed out here, keeping the others). */
  async function active(
    h: Held,
    req: Request,
    nowS: number,
    o: { quiet: boolean; logView: boolean },
  ): Promise<{ auth: Auth | null; reason: import('./denial.js').SessionLossReason | null; session: RetainedSession | null }> {
    const id = h.browser.activeSessionId
    if (!id) return { auth: null, reason: null, session: null }
    const session = (await store.sessions(h.binding, nowS)).find(s => s.id === id) ?? null
    if (!session) return { auth: null, reason: 'expired', session: null }
    return { ...(await deps.resolve(req, { sub: session.sub, iat: session.issuedAt }, nowS, o)), session }
  }

  /** The client's selection context, or a 409-worthy refusal. */
  function expected(req: Request, h: Held): SelectionContext {
    const ctx = parseSelectionContext(req.headers.get(SELECTION_CONTEXT_HEADER))
    if (!ctx || ctx.browserSetId !== h.binding.browserSetId) throw new RetainedLoginError('selection_context_conflict')
    return ctx
  }

  /** Add a fresh login and select it, retrying once if the set moved underneath (another tab). */
  async function add(h: Held, sub: string, issuedAt: number, expiresAt: number, nowS: number): Promise<SelectionContext> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const browser = attempt ? await store.browser(h.binding, nowS) : h.browser
      if (!browser) break
      const ctx = await store.addSession(
        { ...h.binding, expected: contextOf(browser), sessionId: generateId(), sub, issuedAt, expiresAt, select: true },
        nowS,
      )
      if (ctx) return ctx
    }
    throw new RetainedLoginError('retained-login-capacity')
  }

  async function view(h: Held, req: Request, nowS: number): Promise<AccountsResponse> {
    const sessions = await store.sessions(h.binding, nowS)
    const accounts: AccountView[] = []
    for (const s of sessions) {
      const { auth } = await deps.resolve(req, { sub: s.sub, iat: s.issuedAt }, nowS, { quiet: true, logView: false })
      // A login whose evidence no longer holds (a revoked link, a delisted
      // address) isn't offered: switching to it would only fail.
      if (!auth) continue
      const expiresAt = Math.min(s.expiresAt, h.browser.expiresAt)
      accounts.push(
        auth.kind === 'sso'
          ? { id: s.id, kind: 'sso', email: auth.email, name: null, subject: auth.subject, active: s.id === h.browser.activeSessionId, expiresAt }
          : {
              id: s.id,
              kind: 'grant',
              email: auth.grant.email,
              name: auth.grant.name,
              subject: auth.grant.subject,
              active: s.id === h.browser.activeSessionId,
              expiresAt,
            },
      )
    }
    const incomingLinks: IncomingView[] = []
    for (const p of await store.pendings(h.binding, nowS)) {
      const g = await deps.grantById(p.grantId)
      if (g) incomingLinks.push({ id: p.id, name: g.name, email: g.email, subject: g.subject, expiresAt: p.expiresAt })
    }
    return {
      selection: serializeSelectionContext(contextOf(h.browser)),
      active: h.browser.activeSessionId,
      accounts,
      incoming: incomingLinks,
    }
  }

  return {
    handleCookie,
    clearHandle,

    /**
     * The active login's identity when this request carries a handle; `'absent'`
     * when it carries none (the caller then reads a single-session cookie, so a
     * browser from before retention keeps working until its next sign-in).
     */
    async authenticate(req: Request, nowMs: number, logView: boolean) {
      if (readCookie(req, handleCookie) === null) return 'absent' as const
      const nowS = sec(nowMs)
      const h = await held(req, nowS)
      if (!h) return { auth: null, reason: 'invalid' as const }
      const { auth, reason } = await active(h, req, nowS, { quiet: false, logView })
      return { auth, reason }
    },

    /** The serialized selection context for this request's set, or null without one. */
    async selection(req: Request, nowMs: number): Promise<string | null> {
      const h = await held(req, sec(nowMs))
      return h ? serializeSelectionContext(contextOf(h.browser)) : null
    },

    /** An IdP or emailed code vouched for `email`: add that login and make it the active one. */
    async signIn(req: Request, email: string, nowMs: number): Promise<string[]> {
      const nowS = sec(nowMs)
      const { h, cookies } = await ensure(req, nowMs)
      await add(h, emailSub(email), nowS, nowS + deps.sessionTtlS, nowS)
      return cookies
    },

    /**
     * An incoming share link (already found valid and redeemable by the gate).
     * With no usable active login it signs in (one redemption, or none if this
     * browser already holds that link's session). With one, `incoming` decides:
     * keep the current login and hold the link as an account to switch to, or
     * switch now.
     */
    async incoming(
      req: Request,
      grant: Grant,
      tokenHash: string,
      nowMs: number,
    ): Promise<
      | { ok: true; switched: true; minted: boolean; cookies: string[]; selection: string }
      /** `pendingId` null: the link is the active login already. */
      | { ok: true; switched: false; active: Auth; pendingId: string | null; cookies: string[]; selection: string }
      | { ok: false; cookies: string[] }
    > {
      const nowS = sec(nowMs)
      const { h, cookies } = await ensure(req, nowMs)
      const current = await active(h, req, nowS, { quiet: true, logView: false })
      const sessions = await store.sessions(h.binding, nowS)
      const sub = grantSub(grant.id)
      const selectionNow = async () => serializeSelectionContext(contextOf((await store.browser(h.binding, nowS))!))
      if (current.auth && current.session?.sub === sub) {
        return { ok: true, switched: false, active: current.auth, pendingId: null, cookies, selection: await selectionNow() }
      }
      let decision: IncomingDecision = 'switch'
      if (current.auth) {
        decision = typeof incoming === 'function' ? await incoming({ active: current.auth, incoming: grant, req }) : incoming
      }
      const pendingId = generateId()
      let ctx: SelectionContext | null = null
      for (let attempt = 0; attempt < 2 && !ctx; attempt++) {
        const browser = attempt ? await store.browser(h.binding, nowS) : h.browser
        if (!browser) break
        ctx = await store.createPending(
          { ...h.binding, expected: contextOf(browser), pendingId, grantId: grant.id, tokenHash },
          nowS,
        )
      }
      if (!ctx) throw new RetainedLoginError('pending-link-capacity')
      if (decision === 'keep') return { ok: true, switched: false, active: current.auth!, pendingId, cookies, selection: await selectionNow() }
      const minted = !sessions.some(s => s.sub === sub)
      const result = await store.commitIncoming(
        { ...h.binding, expected: ctx, pendingId, grantId: grant.id, tokenHash, operationId: generateId(), newSessionId: generateId(), select: true },
        nowS,
      )
      return result ? { ok: true, switched: true, minted, cookies, selection: await selectionNow() } : { ok: false, cookies }
    },

    /** The logins this browser holds, its active one, and any incoming links waiting on a choice. */
    async accounts(req: Request, nowMs: number): Promise<AccountsResponse | null> {
      const nowS = sec(nowMs)
      const h = await held(req, nowS)
      return h ? await view(h, req, nowS) : null
    },

    /** Switch to one of this browser's logins (or to none). Never extends its evidence. */
    async select(req: Request, sessionId: string | null, nowMs: number): Promise<AccountsResponse | null> {
      const nowS = sec(nowMs)
      const h = await held(req, nowS)
      if (!h) return null
      if (sessionId !== null) {
        // Switching to a login whose evidence no longer holds would only fail on the next request.
        const s = (await store.sessions(h.binding, nowS)).find(x => x.id === sessionId)
        const ok = s && (await deps.resolve(req, { sub: s.sub, iat: s.issuedAt }, nowS, { quiet: true, logView: false })).auth
        if (!ok) return null
      }
      const ctx = await store.select({ ...h.binding, expected: expected(req, h), sessionId }, nowS)
      if (!ctx) throw new RetainedLoginError('selection_context_conflict')
      return await view({ ...h, browser: (await store.browser(h.binding, nowS))! }, req, nowS)
    },

    /** Take one login off this browser. Removing the active one leaves it signed out: nothing else is selected. */
    async remove(req: Request, sessionId: string, nowMs: number): Promise<AccountsResponse | null> {
      const nowS = sec(nowMs)
      const h = await held(req, nowS)
      if (!h) return null
      const ctx = await store.remove({ ...h.binding, expected: expected(req, h), sessionId }, nowS)
      if (!ctx) throw new RetainedLoginError('selection_context_conflict')
      return await view({ ...h, browser: (await store.browser(h.binding, nowS))! }, req, nowS)
    },

    /** Choose a held incoming link: it becomes a login (spending a redemption only if it's new here) and the active one. */
    async acceptIncoming(req: Request, pendingId: string, nowMs: number): Promise<AccountsResponse | null> {
      const nowS = sec(nowMs)
      const h = await held(req, nowS)
      if (!h) return null
      const p = (await store.pendings(h.binding, nowS)).find(x => x.id === pendingId)
      if (!p) return null
      const ctx = expected(req, h)
      const result = await store.commitIncoming(
        {
          ...h.binding,
          expected: ctx,
          pendingId,
          grantId: p.grantId,
          tokenHash: p.tokenHash,
          operationId: generateId(),
          newSessionId: generateId(),
          select: true,
        },
        nowS,
      )
      if (!result) {
        // Unchanged since the client looked: the link itself can't be taken now.
        const now = await store.browser(h.binding, nowS)
        const stale = !now || now.version !== ctx.version || now.activeSessionId !== ctx.sessionId
        throw new RetainedLoginError(stale ? 'selection_context_conflict' : 'incoming-unavailable')
      }
      return await view({ ...h, browser: (await store.browser(h.binding, nowS))! }, req, nowS)
    },

    /**
     * Sign out of the active login only: it's removed from this browser, and
     * the others stay. A stale selection header is refused. No header at all
     * is what a client from before retained mode sends; it signs out whichever
     * login is active now, since a sign-out can only ever take access away.
     */
    async signOut(req: Request, nowMs: number): Promise<string[]> {
      const nowS = sec(nowMs)
      const h = await held(req, nowS)
      const cookies = readCookie(req, deps.gateCookie) !== null ? [clearLegacy(req)] : []
      if (!h || !h.browser.activeSessionId) return cookies
      const sent = req.headers.get(SELECTION_CONTEXT_HEADER) === null ? contextOf(h.browser) : expected(req, h)
      const ctx = await store.remove({ ...h.binding, expected: sent, sessionId: h.browser.activeSessionId }, nowS)
      if (!ctx) throw new RetainedLoginError('selection_context_conflict')
      return cookies
    },

    /** Sign this browser out of every login it holds; the handle is cleared. Other browsers are untouched. */
    async signOutAll(req: Request, nowMs: number): Promise<string[]> {
      const nowS = sec(nowMs)
      const h = await held(req, nowS)
      if (h) await store.endBrowser(h.binding, nowS)
      return [clearHandle(req), ...(readCookie(req, deps.gateCookie) !== null ? [clearLegacy(req)] : [])]
    },

    /**
     * For an app's own cookie-authenticated mutations: refuse one sent under a
     * selection the browser has since left (another tab switched accounts),
     * before any side effect. Null = go ahead. Bearer requests and requests
     * without a handle aren't subject to it.
     */
    async checkMutation(req: Request, nowMs: number): Promise<Response | null> {
      if (/^Bearer(?:\s|$)/i.test(req.headers.get('Authorization') ?? '')) return null
      const h = await held(req, sec(nowMs))
      if (!h) return null
      const sent = req.headers.get(SELECTION_CONTEXT_HEADER)
      if (sent !== null && sent === serializeSelectionContext(contextOf(h.browser))) return null
      return selectionConflict()
    },
  }
}

export const selectionConflict = (): Response =>
  new Response(JSON.stringify({ error: 'selection_context_conflict', recoverable: true, action: 'refresh_selection' }) + '\n', {
    status: 409,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

export type RetainedMode = ReturnType<typeof retainedMode>
