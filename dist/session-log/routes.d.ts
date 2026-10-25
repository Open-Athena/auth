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
import { type AppEvents, type SlogBatch, type SlogEvent } from '../core/session-log-shape.js';
import { type SessionLogStore, type SessionLogWho, type SwitchRow } from './store.js';
export interface SessionLogRoutesOptions {
    store: SessionLogStore;
    /** Default `/api/session-log`. */
    basePath?: string;
    /** This request's viewer, or null (nothing is logged for it: a sign-in page never logs). */
    identify: (req: Request) => Promise<SessionLogWho | null>;
    /** An admin's name for the record, or the refusal to send (401 / 403). */
    requireAdmin: (req: Request) => Promise<{
        who: string;
    } | Response>;
    /** App events this deployment accepts, by name, with their fields (`checkAppEvents`). */
    appEvents?: AppEvents;
    /** Days a batch is kept (default 30). */
    retainDays?: number;
    /** Drop events before storage (an admin's per-kind mute, say). An empty result stores nothing. */
    filterEvents?: (events: SlogEvent[], req: Request) => SlogEvent[] | Promise<SlogEvent[]>;
    /** After a batch is stored (an activity feed, say). Run through `waitUntil` when given, else awaited. */
    onStored?: (e: {
        batch: SlogBatch;
        who: SessionLogWho;
        req: Request;
    }) => void | Promise<void>;
    /** After the switch changes: record it in your audit trail. */
    onSwitch?: (e: {
        prior: SwitchRow | null;
        row: SwitchRow;
        req: Request;
    }) => void | Promise<void>;
    /** After each retention purge (purge your own derived tables at the same cutoff). */
    onPurge?: (cutoffS: number) => void | Promise<void>;
    /** How long a read of the switch is trusted (default 60 s). */
    switchTtlMs?: number;
    /** Retention purge interval (default 1 h). */
    purgeEveryMs?: number;
}
/** The platform's `waitUntil`, for work that may finish after the response. */
export interface SessionLogCtx {
    waitUntil?: (p: Promise<unknown>) => void;
}
export declare function sessionLogRoutes(opts: SessionLogRoutesOptions): (req: Request, ctx?: SessionLogCtx) => Promise<Response | null>;
