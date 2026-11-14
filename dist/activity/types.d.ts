/** Activity is staff-only data. Mount reads behind the application's admin authorization. */
export type ActivityMode = 'off' | 'count' | 'line';
export interface ActivityKind {
    record: ActivityMode;
    /** Cannot retain or disclose more detail than `record`. */
    notify: ActivityMode;
}
export type ActivityKinds = Readonly<Record<string, ActivityKind>>;
export declare const DEFAULT_ACTIVITY_KINDS: ActivityKinds;
export declare const BATCH_GAP_S: number;
export declare const ACTIVITY_LINES = 100;
export interface ActivityActor {
    /** Stable identity, not a display name. Include the grant ID for an unbound share link. */
    id: string;
    name: string;
    via: string;
}
export interface ActivityEvent {
    /** Caller-supplied, stable replay key, unique within this store. Never a credential. */
    id: string;
    actor: ActivityActor;
    /** HTTP(S) origin; separates the same actor's activity on different sites. */
    origin: string;
    /** Epoch seconds. Client bridges clamp future timestamps to receipt time. */
    ts: number;
    kind: string;
    line?: string;
    /** Only a pathname is retained, never query strings or fragments. */
    path?: string;
    sessionId?: string;
}
export interface ActivityWrite extends ActivityEvent {
    policy: ActivityKind;
}
export interface ActivityLine {
    id: string;
    ts: number;
    kind: string;
    line: string | null;
    path: string | null;
    sessionId: string | null;
    notify: ActivityMode;
}
export interface ActivityBurst {
    id: string;
    actor: ActivityActor;
    origin: string;
    firstTs: number;
    lastTs: number;
    receivedTs: number;
    version: number;
    counts: Record<string, number>;
    notifyCounts: Record<string, number>;
    /** Latest `ACTIVITY_LINES` recorded lines, in timestamp/ID order. Count-only rows have no detail. */
    lines: ActivityLine[];
    omittedLines: number;
}
export type ActivityRecordResult = {
    status: 'off';
    burstId: null;
} | {
    status: 'stored' | 'duplicate';
    burstId: string;
};
export interface ActivityClaim {
    token: string;
    messageId: string | null;
    /** Consecutive failed sends of this burst to this sink. */
    failures: number;
}
/** After the nth consecutive failure, a burst waits `min(2^(n-1) × 30s, 15 min)` before its next send to that sink. */
export declare const ACTIVITY_RETRY_S = 30;
export declare const ACTIVITY_RETRY_MAX_S: number;
export interface ActivityFilter {
    actorId?: string;
    origin?: string;
    since?: number;
    limit?: number;
}
/** Implementations must make append and claim atomic across independent callers. */
export interface ActivityStore {
    readKinds(): Promise<Record<string, ActivityKind>>;
    writeKind(kind: string, policy: ActivityKind): Promise<void>;
    append(event: ActivityWrite, nowS: number, gapS: number): Promise<Exclude<ActivityRecordResult, {
        status: 'off';
    }>>;
    get(id: string): Promise<ActivityBurst | null>;
    list(filter?: ActivityFilter): Promise<ActivityBurst[]>;
    pending(sink: string, limit: number): Promise<string[]>;
    claim(burstId: string, sink: string, nowS: number, leaseS: number): Promise<ActivityClaim | null>;
    complete(burstId: string, sink: string, token: string, messageId: string, version: number): Promise<boolean>;
    release(burstId: string, sink: string, token: string): Promise<void>;
    /** Drop the claim after a failed send, count the failure, and refuse claims until `retryAtS`. */
    defer(burstId: string, sink: string, token: string, retryAtS: number): Promise<void>;
    /** Bounded incremental purge by server receipt time; no remote messages are deleted. */
    purge(cutoffS: number, nowS: number, limit?: number): Promise<{
        events: number;
        bursts: number;
        posts: number;
    }>;
}
/** A stable sink ID identifies one destination; change it when changing channel/webhook. */
export interface ActivitySink {
    id: string;
    /** Explicit acknowledgement: every sink receives private staff-facing activity. */
    staffOnly: true;
    send(burst: ActivityBurst, messageId: string | null): Promise<string>;
}
