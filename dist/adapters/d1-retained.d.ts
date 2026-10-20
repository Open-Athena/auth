import type { RetainedLimits, RetainedStore } from '../core/retained-store.js';
/** Internal optional adapter: requires migration 0003 and transactional D1 batch.
 * No read/independent-write completion, compensations or network policy callbacks.
 * Caller must enforce deployment rate admission before bootstrap/pending creation.
 * Hard storage quotas count expired rows too until explicit maintenance removes
 * them. Cleanup and the rest of the registry are intentionally not implemented.
 */
export declare function d1RetainedStore(db: D1Database, suppliedLimits: RetainedLimits): RetainedStore;
