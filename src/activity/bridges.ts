import type { AccessEvent } from '../core/audit.js'
import { isErrorEvent, type SlogBatch, type SlogEvent } from '../core/session-log-shape.js'
import type { Auth } from '../core/types.js'
import type { SessionLogWho } from '../session-log/store.js'
import type { ActivityFeed } from './index.js'
import { activityInteger, activityPath, activityText } from './shape.js'
import type { ActivityActor, ActivityEvent, ActivityRecordResult } from './types.js'

/** Use only a trusted server identity. The private grant memo is deliberately not used as a recipient name. */
export function activityActorFromAuth(auth: Auth): ActivityActor {
  return auth.kind === 'sso'
    ? { id: `email:${auth.email}`, name: auth.subject?.name?.trim() || auth.email, via: 'sso' }
    : { id: `grant:${auth.grant.id}`, name: auth.grant.subject?.name?.trim() || auth.grant.email || 'Unnamed recipient', via: 'grant' }
}

interface StoredSession { batch: SlogBatch; who: SessionLogWho; req: Request }

export interface SessionActivityOptions {
  /** Required: core SessionLogWho has no stable identity for an unbound grant. Never trust batch fields for it. */
  actor: (input: StoredSession) => ActivityActor | null | Promise<ActivityActor | null>
  now?: () => number
  /**
   * Optional app-specific conversion. Null drops an event; no arbitrary client fields are copied by default.
   * `receivedMs` is when the server received the batch, for `isErrorEvent`'s offline-failure rule.
   */
  event?: (event: SlogEvent, receivedMs: number) => Pick<ActivityEvent, 'kind' | 'line' | 'path'> | null
}

function sessionEvent(event: SlogEvent, receivedMs: number): Pick<ActivityEvent, 'kind' | 'line' | 'path'> | null {
  const { k } = event
  if (k === 'dropped') return null
  if (isErrorEvent(event, receivedMs)) return { kind: 'error', line: String(event.msg ?? `${k} ${event.s ?? ''}`).slice(0, 2000) }
  if (k === 'start' || k === 'nav') {
    const path = typeof event.u === 'string' ? activityPath(event.u) : undefined
    return { kind: k === 'start' ? 'view' : 'nav', line: path, path }
  }
  if (k === 'click') return { kind: 'click', line: String(event.l ?? event.n ?? 'click').slice(0, 2000) }
  return null
}

/** Structurally compatible with sessionLogRoutes' onStored/onPurge; session retention remains independent. */
export function sessionLogActivity(feed: ActivityFeed, options: SessionActivityOptions) {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  return {
    async onStored(input: StoredSession): Promise<void> {
      const actor = await options.actor(input)
      if (!actor) return
      const { batch, req } = input
      const receipt = now()
      // Stable per-event keys allow safe retry after partially bridging a stored batch.
      for (const [index, event] of batch.events.entries()) {
        const mapped = (options.event ?? sessionEvent)(event, receipt * 1000)
        if (!mapped) continue
        await feed.record({
          ...mapped,
          id: `session:${JSON.stringify([new URL(req.url).origin, batch.sid, batch.pid, batch.seq, index])}`,
          actor,
          origin: new URL(req.url).origin,
          ts: Math.min(receipt, Math.floor(event.t / 1000)),
          sessionId: batch.sid,
        })
      }
    },
    async onPurge(cutoffS: number): Promise<void> { await feed.purge(cutoffS) },
  }
}

export interface AccessActivityOptions {
  origin: string
  /** Resolve grants by ID server-side; access rows themselves contain no recipient subject. */
  actor: (event: AccessEvent) => ActivityActor | null | Promise<ActivityActor | null>
}

/**
 * Replay an accepted access-log row with its stable database ID (namespace it
 * when combining stores). Not an AuditSink wrapper: that interface has no row
 * ID or insert outcome, so it cannot safely mirror the access store's dedupe.
 * Browser and access views are independent observations; choose which to feed
 * for overlapping routes. No attempt is made to guess cross-source equality.
 */
export function accessLogActivity(feed: ActivityFeed, options: AccessActivityOptions) {
  return async (id: string, event: AccessEvent): Promise<ActivityRecordResult | null> => {
    activityText(id, 'access row id', 256)
    activityInteger(event.ts, 'access timestamp')
    const actor = await options.actor(event)
    if (!actor) return null
    const path = event.path ? activityPath(event.path) : undefined
    return feed.record({
      id: `access:${JSON.stringify([options.origin, id])}`,
      actor,
      origin: options.origin,
      ts: event.ts,
      kind: event.event === 'view' ? 'view' : 'access',
      line: `${event.event}${path ? ` ${path}` : ''}`,
      path,
    })
  }
}
