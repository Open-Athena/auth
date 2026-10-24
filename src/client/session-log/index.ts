/**
 * `@open-athena/auth/session-log/client`: the session log's boot shim, the only
 * part an app loads up front. `bootSessionLog` asks the endpoint whether this
 * tab logs right now; if so it imports the logger chunk (`./logger.js`) and
 * hands it the events raised meanwhile. Off (the default), it is one request
 * per page load and nothing else. Importing this module installs nothing: no
 * listener exists until `bootSessionLog` runs.
 *
 * `slog` is the app's hook for events the page can't see on its own: an app
 * event declared on the server (`appEvents`), or a built-in kind such as
 * `pick` from a custom picker.
 */
import type { AppEvents, Kind, SessionLogConfig, SlogEvent } from '../../core/session-log-shape.js'

export type * from '../../core/session-log-shape.js'

type Fields = Record<string, unknown>

let sink: ((k: Kind, f?: Fields) => void) | null = null
let state: 'idle' | 'pending' | 'on' | 'off' = 'idle'
const early: SlogEvent[] = []
const EARLY_MAX = 20

/** Record an event (a no-op while off; held briefly while the boot decides). */
export function slog(k: Kind, f: Fields = {}): void {
  if (sink) {
    sink(k, f)
    return
  }
  if ((state === 'pending' || state === 'idle') && early.length < EARLY_MAX) early.push({ t: Date.now(), k, ...f } as SlogEvent)
}

export interface BootOptions {
  /** The app's build id (a git SHA, say), recorded on every batch. */
  build: string
  /** Default `/api/session-log`. */
  endpoint?: string
  /** More URL params to mask, besides the built-in secret ones. */
  secretParams?: readonly string[]
}

/** Whether a config answer means "log this tab now". */
export const shouldLog = (cfg: Partial<SessionLogConfig> | null, now = Date.now()): cfg is SessionLogConfig & { until: number } =>
  !!cfg?.enabled && typeof cfg.until === 'number' && cfg.until > now

/**
 * Decide, then start or stand down. Never throws and never delays the app:
 * call it without awaiting, once, at startup. Resolves to whether it started.
 */
export async function bootSessionLog(o: BootOptions): Promise<boolean> {
  if (state !== 'idle') return state === 'on'
  state = 'pending'
  const endpoint = o.endpoint ?? '/api/session-log'
  const onError = (e: Event) => {
    const ee = e as ErrorEvent
    slog('error', { msg: String(ee.message || ee.error).slice(0, 300) })
  }
  const onReject = (e: Event) => slog('reject', { msg: String((e as PromiseRejectionEvent).reason).slice(0, 300) })
  addEventListener('error', onError)
  addEventListener('unhandledrejection', onReject)
  let cfg: Partial<SessionLogConfig> | null = null
  try {
    const r = await fetch(endpoint, { credentials: 'same-origin', cache: 'no-store' })
    if (r.ok) cfg = await r.json()
  } catch {
    // Off.
  }
  removeEventListener('error', onError)
  removeEventListener('unhandledrejection', onReject)
  const standDown = (): false => {
    state = 'off'
    early.length = 0
    return false
  }
  if (!shouldLog(cfg)) return standDown()
  try {
    const m = await import('./logger.js')
    const appEvents: AppEvents = cfg.appEvents ?? {}
    const { log, logger } = m.start({
      until: cfg.until,
      early: early.splice(0),
      build: o.build,
      endpoint,
      appEvents,
      secretParams: o.secretParams,
    })
    sink = log
    state = 'on'
    const prevStop = logger.onStop
    logger.onStop = () => {
      prevStop?.()
      sink = null
      state = 'off'
    }
    return true
  } catch {
    return standDown()
  }
}

/** Forget the boot (tests): back to idle, nothing held. */
export function resetSessionLog(): void {
  sink = null
  state = 'idle'
  early.length = 0
}
