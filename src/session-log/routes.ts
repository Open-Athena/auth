/**
 * The session log's endpoints, framework-neutral (a `Request` in, a
 * `Response` or null out, like `authRoutes`):
 *
 *   GET  <base>                  SessionLogConfig                    anyone (`enabled` only for a viewer)
 *   POST <base>                  a client batch → 204                 a viewer, while on
 *   GET  <base>/switch           SwitchState                          admin
 *   PUT  <base>/switch           {enabled, until?, indefinite?}       admin
 *   GET  <base>/sessions         SessionPage                          admin (?email= &since= &errors=1 &limit= &after= | &before=)
 *   GET  <base>/sessions/:sid    SessionDetail                        admin
 *
 * Off unless an admin turns the switch on; on, it ends by itself at its
 * `until` (default 7 days, at most 31), or never (`indefinite`) until an admin
 * turns it off. The switch is read at most once per `switchTtlMs` per routes
 * instance (one per isolate), so a change reaches every tab within a minute;
 * the cache holds the end instant, not the answer, so expiry stays exact. The
 * identity is the request's (`identify`), never the client's say. The
 * retention purge rides the config GET and each page load's first batch, at
 * most once per `purgeEveryMs`, whether logging is on or off.
 */
import {
  type AppEvents,
  checkAppEvents,
  defaultUntil,
  FOREVER_MS,
  isForever,
  isOn,
  LIMITS,
  maxUntil,
  parseCursor,
  parseUntil,
  type SessionLogConfig,
  type SlogBatch,
  type SlogEvent,
  type SwitchState,
  switchState,
  validateBatch,
} from '../core/session-log-shape.js'
import { SessionLogNotSetUp, type SessionLogStore, type SessionLogWho, type SwitchRow } from './store.js'

export interface SessionLogRoutesOptions {
  store: SessionLogStore
  /** Default `/api/session-log`. */
  basePath?: string
  /** This request's viewer, or null (nothing is logged for it: a sign-in page never logs). */
  identify: (req: Request) => Promise<SessionLogWho | null>
  /** An admin's name for the record, or the refusal to send (401 / 403). */
  requireAdmin: (req: Request) => Promise<{ who: string } | Response>
  /** App events this deployment accepts, by name, with their fields (`checkAppEvents`). */
  appEvents?: AppEvents
  /** Days a batch is kept (default 30). */
  retainDays?: number
  /** Drop events before storage (an admin's per-kind mute, say). An empty result stores nothing. */
  filterEvents?: (events: SlogEvent[], req: Request) => SlogEvent[] | Promise<SlogEvent[]>
  /** After a batch is stored (an activity feed, say). Run through `waitUntil` when given, else awaited. */
  onStored?: (e: { batch: SlogBatch; who: SessionLogWho; req: Request }) => void | Promise<void>
  /** After the switch changes: record it in your audit trail. */
  onSwitch?: (e: { prior: SwitchRow | null; row: SwitchRow; req: Request }) => void | Promise<void>
  /** After each retention purge (purge your own derived tables at the same cutoff). */
  onPurge?: (cutoffS: number) => void | Promise<void>
  /** How long a read of the switch is trusted (default 60 s). */
  switchTtlMs?: number
  /** Retention purge interval (default 1 h). */
  purgeEveryMs?: number
}

/** The platform's `waitUntil`, for work that may finish after the response. */
export interface SessionLogCtx {
  waitUntil?: (p: Promise<unknown>) => void
}

const NO_STORE = { 'cache-control': 'no-store' }
const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } })

export function sessionLogRoutes(opts: SessionLogRoutesOptions) {
  const {
    store,
    basePath = '/api/session-log',
    identify,
    requireAdmin,
    retainDays = 30,
    switchTtlMs = 60_000,
    purgeEveryMs = 3_600_000,
  } = opts
  const appEvents = checkAppEvents(opts.appEvents ?? {})
  /** This instance's last read of the switch (`at` null = none yet). */
  const cache: { at: number | null; row: SwitchRow | null | 'missing' } = { at: null, row: null }
  let lastPurge = 0

  async function readSwitch(now: number, fresh = false): Promise<SwitchRow | null | 'missing'> {
    if (!fresh && cache.at !== null && now - cache.at < switchTtlMs) return cache.row
    cache.row = await store.readSwitch()
    cache.at = now
    return cache.row
  }

  async function current(now: number): Promise<{ until: number | null; reason: string | null }> {
    const row = await readSwitch(now)
    if (row === 'missing') return { until: null, reason: 'not set up' }
    return switchState(row?.until_ms ?? null, now)
  }

  const later = (ctx: SessionLogCtx | undefined, p: Promise<unknown>): Promise<unknown> | null => {
    const quiet = p.catch(e => console.log(`session log: ${(e as Error).message}`))
    if (ctx?.waitUntil) {
      ctx.waitUntil(quiet)
      return null
    }
    return quiet
  }

  function purgeLater(ctx: SessionLogCtx | undefined, now: number): Promise<unknown> | null {
    if (now - lastPurge < purgeEveryMs) return null
    lastPurge = now
    const cutoff = Math.floor(now / 1000) - retainDays * 86_400
    return later(
      ctx,
      (async () => {
        await store.purge(cutoff)
        await opts.onPurge?.(cutoff)
      })(),
    )
  }

  async function config(req: Request, ctx?: SessionLogCtx): Promise<Response> {
    const now = Date.now()
    await purgeLater(ctx, now)
    const u = await current(now)
    const shared = { on: isOn(u), retainDays, appEvents }
    const off = (reason: string | null): Response =>
      json({ enabled: false, until: u.until, reason, ...shared } satisfies SessionLogConfig, 200, NO_STORE)
    if (!isOn(u)) return off(u.reason)
    if (!(await identify(req))) return off('no viewer identity')
    return json({ enabled: true, until: u.until, reason: null, ...shared } satisfies SessionLogConfig, 200, NO_STORE)
  }

  async function post(req: Request, ctx?: SessionLogCtx): Promise<Response> {
    const now = Date.now()
    if (!isOn(await current(now))) return json({ error: 'session log is off' }, 503)
    const who = await identify(req)
    if (!who) return json({ error: 'unauthenticated' }, 401)
    if (Number(req.headers.get('content-length') ?? 0) > LIMITS.bodyBytes) {
      return json({ error: `body over ${LIMITS.bodyBytes} bytes` }, 413)
    }
    const text = await req.text()
    if (new TextEncoder().encode(text).length > LIMITS.bodyBytes) return json({ error: `body over ${LIMITS.bodyBytes} bytes` }, 413)
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return json({ error: 'body is not JSON' }, 400)
    }
    const v = validateBatch(raw, appEvents)
    if ('error' in v) return json({ error: v.error }, v.status)
    const events = opts.filterEvents ? await opts.filterEvents(v.batch.events, req) : v.batch.events
    if (!events.length) return new Response(null, { status: 204 })
    const batch = { ...v.batch, events }
    const r = await store.ingest(who, req.headers.get('user-agent'), batch, Math.floor(now / 1000))
    if (batch.seq === 0) await purgeLater(ctx, now)
    if (r === 'capped') return json({ error: `session over ${LIMITS.sessionEvents} events` }, 429)
    if (r === 'stored' && opts.onStored) await later(ctx, Promise.resolve(opts.onStored({ batch, who, req })))
    return new Response(null, { status: 204 })
  }

  async function switchRoute(req: Request): Promise<Response> {
    const admin = await requireAdmin(req)
    if (admin instanceof Response) return admin
    const now = Date.now()
    const bounds = { defaultUntil: defaultUntil(now), maxUntil: maxUntil(now) }
    if (req.method === 'PUT') {
      let body: { enabled?: unknown; until?: unknown; indefinite?: unknown }
      try {
        body = await req.json()
      } catch {
        return json({ error: 'body is not JSON' }, 400)
      }
      if (typeof body?.enabled !== 'boolean') return json({ error: 'enabled must be true or false' }, 400)
      if (body.until !== undefined && body.until !== null && typeof body.until !== 'string') {
        return json({ error: 'until must be a date string' }, 400)
      }
      if (body.indefinite !== undefined && typeof body.indefinite !== 'boolean') {
        return json({ error: 'indefinite must be true or false' }, 400)
      }
      const indefinite = body.indefinite === true
      if (indefinite && !body.enabled) return json({ error: 'indefinite needs enabled: true' }, 400)
      if (indefinite && typeof body.until === 'string' && body.until.trim()) {
        return json({ error: 'until and indefinite are exclusive' }, 400)
      }
      let untilMs: number | null = null
      if (indefinite) untilMs = FOREVER_MS
      else if (body.enabled) {
        const u = parseUntil(body.until as string | null | undefined, now)
        if ('error' in u) return json({ error: u.error }, 400)
        untilMs = u.until
      }
      const change = await store.writeSwitch(untilMs, admin.who, Math.floor(now / 1000))
      await opts.onSwitch?.({ ...change, req })
    }
    // Admin reads bypass the cache (and refresh it): the switch as stored, right
    // now, so this isolate's tabs see a change at once, the others within the TTL.
    const row = await readSwitch(now, true)
    if (row === 'missing') {
      return json(
        { enabled: false, until: null, indefinite: false, reason: 'not set up', who: null, ts: null, ...bounds } satisfies SwitchState,
        200,
        NO_STORE,
      )
    }
    const u = switchState(row?.until_ms ?? null, now)
    return json(
      {
        enabled: isOn(u),
        until: u.until,
        indefinite: isOn(u) && isForever(u.until),
        reason: u.reason,
        who: row?.who ?? null,
        ts: row?.ts ?? null,
        ...bounds,
      } satisfies SwitchState,
      200,
      NO_STORE,
    )
  }

  async function sessions(req: Request, rest: string): Promise<Response> {
    const admin = await requireAdmin(req)
    if (admin instanceof Response) return admin
    const q = new URL(req.url).searchParams
    if (rest === 'sessions') {
      const since = q.get('since')
      const sinceMs = since ? Date.parse(since) : NaN
      const limit = Number(q.get('limit'))
      const after = q.get('after')
      const before = q.get('before')
      if (after && before) return json({ error: 'after and before are exclusive' }, 400)
      const raw = after ?? before
      const cursor = raw ? parseCursor(raw) : null
      if (raw && !cursor) return json({ error: `bad cursor: ${raw.slice(0, 60)}` }, 400)
      const page = await store.listSessions({
        email: q.get('email') || undefined,
        since: Number.isFinite(sinceMs) ? sinceMs : undefined,
        errors: q.get('errors') === '1',
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        ...(cursor ? (after ? { after: cursor } : { before: cursor }) : {}),
      })
      return json(page, 200, NO_STORE)
    }
    const sid = rest.slice('sessions/'.length)
    const d = await store.sessionDetail(sid)
    return d ? json(d, 200, NO_STORE) : json({ error: `no session ${sid}` }, 404)
  }

  return async function handle(req: Request, ctx?: SessionLogCtx): Promise<Response | null> {
    const url = new URL(req.url)
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return null
    const rest = url.pathname.slice(basePath.length).replace(/^\/|\/$/g, '')
    const m = req.method
    try {
      if (rest === '') {
        if (m === 'GET') return await config(req, ctx)
        if (m === 'POST') return await post(req, ctx)
        return json({ error: 'method not allowed' }, 405)
      }
      if (rest === 'switch') {
        return m === 'GET' || m === 'PUT' ? await switchRoute(req) : json({ error: 'method not allowed' }, 405)
      }
      if (rest === 'sessions' || /^sessions\/[A-Za-z0-9_-]+$/.test(rest)) {
        return m === 'GET' ? await sessions(req, rest) : json({ error: 'method not allowed' }, 405)
      }
      return json({ error: 'not found' }, 404)
    } catch (e) {
      if (e instanceof SessionLogNotSetUp) return json({ error: e.message }, 503)
      throw e
    }
  }
}
