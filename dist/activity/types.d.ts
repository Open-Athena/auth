/** Activity is staff-only data. Mount reads behind the application's admin authorization. */
export type ActivityMode = 'off' | 'count' | 'line';
export interface ActivityKind {
    record: ActivityMode;
    /** Cannot retain or disclose more detail than `record`. */
    notify: ActivityMode;
}
export type ActivityKinds = Readonly<Record<string, ActivityKind>>;
export declare const DEFAULT_ACTIVITY_KINDS: ActivityKinds;
/** Inactivity that ends a burst. Web analytics' usual session timeout is 30 minutes (Catledge & Pitkow, 1995). */
export declare const BATCH_GAP_S: number;
/** How far back a tab's session resumes its own earlier burst. */
export declare const RESUME_S: number;
/** How events are grouped into bursts (one burst is one Slack thread). */
export interface ActivityGrouping {
    /** Inactivity timeout: an event more than this after the burst's last one starts a new burst. */
    gapS: number;
    /** How long after a gap a tab's session still rejoins its own burst, with a `resume` line; 0 never. */
    resumeS: number;
    /** The longest a burst may span, first event to last; past it a new one starts even without a gap. Null: no cap. */
    maxSpanS: number | null;
    /** `actor`: one burst for a person across their tabs. `session`: one per tab (events with no session join the actor's latest). */
    by: 'actor' | 'session';
}
export declare const ACTIVITY_LINES = 100;
export interface ActivityActor {
    /** Stable identity, not a display name. Include the grant ID for an unbound share link. */
    id: string;
    name: string;
    /** How they got in: `sso`, `grant`, or `service` for a service link (a job, not a person). */
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
    /**
     * An opaque client fingerprint (a hash of the IP hash and user agent, say; never a raw address). Stored at any
     * record level: a service link's burst from a client it hasn't used before is notable.
     */
    client?: string;
}
export interface ActivityWrite extends ActivityEvent {
    policy: ActivityKind;
    /** The `resume` kind's policy: a session rejoining its own earlier burst records a `resume` line when this records. */
    resumePolicy?: ActivityKind;
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
    /** The burst's sessions (tabs), oldest first, at most `ACTIVITY_SESSIONS`. */
    sessionIds: string[];
    /** Set by the feed for a service link's burst it posts: red (notable, with why) or green (clean again after a red). */
    notice?: ActivityNotice;
}
export interface ActivityNotice {
    color: 'red' | 'green';
    reasons: string[];
}
export declare const ACTIVITY_SESSIONS = 50;
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
    /** Thread replies already posted, by slot (see `ActivitySendContext`). */
    parts: Record<string, string>;
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
    append(event: ActivityWrite, nowS: number, grouping: ActivityGrouping): Promise<Exclude<ActivityRecordResult, {
        status: 'off';
    }>>;
    get(id: string): Promise<ActivityBurst | null>;
    list(filter?: ActivityFilter): Promise<ActivityBurst[]>;
    pending(sink: string, limit: number): Promise<string[]>;
    claim(burstId: string, sink: string, nowS: number, leaseS: number): Promise<ActivityClaim | null>;
    complete(burstId: string, sink: string, token: string, messageId: string, version: number): Promise<boolean>;
    release(burstId: string, sink: string, token: string): Promise<void>;
    /** This burst's clients that the same actor (and origin) never used in an earlier burst; empty when it has no earlier burst. */
    newClients(burstId: string): Promise<string[]>;
    /** Whether the actor's last service notice (on this origin, in this sink) was red. */
    serviceRed(actorId: string, origin: string, sink: string): Promise<boolean>;
    setServiceRed(actorId: string, origin: string, sink: string, red: boolean, nowS: number): Promise<void>;
    /** Save a send's progress under its lease, so a failure partway through doesn't post the parent twice. False when the lease is lost. */
    checkpoint(burstId: string, sink: string, token: string, messageId: string, parts: Record<string, string>): Promise<boolean>;
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
    /**
     * Post the burst (`messageId` null) or edit its message, returning the message id. A threaded sink posts
     * replies too, recording each in `ctx.parts` and saving progress with `ctx.save` as it goes.
     */
    send(burst: ActivityBurst, messageId: string | null, ctx?: ActivitySendContext): Promise<string>;
}
export interface ActivitySendContext {
    /** Replies already posted for this burst, by slot (`details`, or `kind:<kind>`). */
    parts: Readonly<Record<string, string>>;
    /** Persist progress under the current lease: the parent id and every reply posted so far. */
    save(messageId: string, parts: Record<string, string>): Promise<void>;
}
