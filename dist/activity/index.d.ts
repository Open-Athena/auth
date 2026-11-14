import { type ActivityEvent, type ActivityKind, type ActivityKinds, type ActivityBurst, type ActivityRecordResult, type ActivitySink, type ActivityStore } from './types.js';
export * from './types.js';
export { activityActorFromAuth, sessionLogActivity, accessLogActivity } from './bridges.js';
export type { SessionActivityOptions, AccessActivityOptions } from './bridges.js';
export { activityRoutes, type ActivityRoutesOptions } from './routes.js';
export { DISCORD_FMT, fmtGap, renderDetails, renderHeadline, renderKindLines, SLACK_FMT, type ActivityFmt, type ActivityLinks } from './render.js';
export interface ActivityFeedOptions {
    store: ActivityStore;
    /** Custom kinds and overrides for the generic defaults. Undeclared kinds are off. */
    kinds?: ActivityKinds;
    sinks?: readonly ActivitySink[];
    gapS?: number;
    leaseS?: number;
    /** Epoch seconds; injectable for deterministic tests. */
    now?: () => number;
    /**
     * Service links (actors with `via: 'service'`): their routine bursts post nothing. A notable one posts red, with
     * why; the next clean one after a red posts green. `notable` replaces the default reasons (`serviceReasons`).
     */
    service?: {
        notable?: (burst: ActivityBurst, ctx: {
            newClients: string[];
        }) => string[] | Promise<string[]>;
        /** Errors in one burst that make it notable (default 3). */
        errorThreshold?: number;
    };
}
/** Why a service burst is notable, by default: a run of errors, any refused request, or a client it hasn't used before. */
export declare function serviceReasons(burst: ActivityBurst, newClients: readonly string[], errorThreshold?: number): string[];
/**
 * `busy`: another caller holds the lease, or this burst is backing off after a failed send.
 * `quiet`: a service link's routine burst, marked delivered with nothing posted.
 */
export type ActivityDelivery = {
    sink: string;
    status: 'sent' | 'busy' | 'missing' | 'fenced' | 'quiet';
};
export declare function activityFeed(options: ActivityFeedOptions): {
    kinds: () => Promise<Record<string, ActivityKind>>;
    setKind(kind: string, policy: ActivityKind): Promise<void>;
    record(event: ActivityEvent): Promise<ActivityRecordResult>;
    deliver(burstId: string): Promise<ActivityDelivery[]>;
    /** At most `limit` burst attempts per sink; a failure rejects and leaves later work pending. */
    flush(limit?: number): Promise<ActivityDelivery[]>;
    /** Whole inactive bursts, by server receipt time. Call repeatedly while deletion counts are nonzero. */
    purge: (cutoffS: number, limit?: number) => Promise<{
        events: number;
        bursts: number;
        posts: number;
    }>;
};
export type ActivityFeed = ReturnType<typeof activityFeed>;
