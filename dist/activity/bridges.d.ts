import type { AccessEvent } from '../core/audit.js';
import { type SlogBatch, type SlogEvent } from '../core/session-log-shape.js';
import type { Auth } from '../core/types.js';
import type { SessionLogWho } from '../session-log/store.js';
import type { ActivityFeed } from './index.js';
import type { ActivityActor, ActivityEvent, ActivityRecordResult } from './types.js';
/** Use only a trusted server identity. The private grant memo is deliberately not used as a recipient name. */
export declare function activityActorFromAuth(auth: Auth): ActivityActor;
interface StoredSession {
    batch: SlogBatch;
    who: SessionLogWho;
    req: Request;
}
export interface SessionActivityOptions {
    /** Required: core SessionLogWho has no stable identity for an unbound grant. Never trust batch fields for it. */
    actor: (input: StoredSession) => ActivityActor | null | Promise<ActivityActor | null>;
    now?: () => number;
    /** Optional app-specific conversion. Null drops an event; no arbitrary client fields are copied by default. */
    event?: (event: SlogEvent) => Pick<ActivityEvent, 'kind' | 'line' | 'path'> | null;
}
/** Structurally compatible with sessionLogRoutes' onStored/onPurge; session retention remains independent. */
export declare function sessionLogActivity(feed: ActivityFeed, options: SessionActivityOptions): {
    onStored(input: StoredSession): Promise<void>;
    onPurge(cutoffS: number): Promise<void>;
};
export interface AccessActivityOptions {
    origin: string;
    /** Resolve grants by ID server-side; access rows themselves contain no recipient subject. */
    actor: (event: AccessEvent) => ActivityActor | null | Promise<ActivityActor | null>;
}
/**
 * Replay an accepted access-log row with its stable database ID (namespace it
 * when combining stores). Not an AuditSink wrapper: that interface has no row
 * ID or insert outcome, so it cannot safely mirror the access store's dedupe.
 * Browser and access views are independent observations; choose which to feed
 * for overlapping routes. No attempt is made to guess cross-source equality.
 */
export declare function accessLogActivity(feed: ActivityFeed, options: AccessActivityOptions): (id: string, event: AccessEvent) => Promise<ActivityRecordResult | null>;
export {};
