import { type ActivityStore } from '../activity/types.js';
/**
 * Optional `migrations/activity/` track. All grouping/dedupe and delivery claims
 * use transactional batches, not isolate-local locks or read/modify/write JSON.
 * Use a primary/first-primary D1 session when read replication is enabled.
 */
export declare function d1ActivityStore(db: D1Database): ActivityStore;
