import { type ActivityEvent, type ActivityKind, type ActivityKinds, type ActivityRecordResult, type ActivitySink, type ActivityStore } from './types.js';
export * from './types.js';
export { activityActorFromAuth, sessionLogActivity, accessLogActivity } from './bridges.js';
export type { SessionActivityOptions, AccessActivityOptions } from './bridges.js';
export interface ActivityFeedOptions {
    store: ActivityStore;
    /** Custom kinds and overrides for the generic defaults. Undeclared kinds are off. */
    kinds?: ActivityKinds;
    sinks?: readonly ActivitySink[];
    gapS?: number;
    leaseS?: number;
    /** Epoch seconds; injectable for deterministic tests. */
    now?: () => number;
}
export type ActivityDelivery = {
    sink: string;
    status: 'sent' | 'busy' | 'missing' | 'fenced';
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
