import type { EmailPolicy } from '../core/policy.js';
export interface GroupSnapshot {
    group: string;
    members: string[];
    /** Successful listing time, epoch seconds; failures must not refresh this. */
    fetchedAt: number;
}
export interface GroupSnapshotStore {
    get(group: string): Promise<GroupSnapshot | null>;
    /** Atomically replace a snapshot unless a newer result is already stored. */
    put(snapshot: GroupSnapshot): Promise<void>;
}
export declare const DEFAULT_GROUP_MAX_AGE_S: number;
/** Check on every authorization request, not only at OAuth sign-in. */
export declare function groupPolicy(store: Pick<GroupSnapshotStore, 'get'>, opts: {
    groups: Readonly<Record<string, readonly string[]>>;
    maxAgeS?: number;
    nowMs?: () => number;
}): EmailPolicy;
