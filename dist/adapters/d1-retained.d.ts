import type { RetainedLimits, RetainedStore } from '../core/retained-store.js';
/** The retained-login registry on D1: requires migrations 0003 and 0004 and transactional D1 batch.
 * No read/independent-write completion, compensations or network policy callbacks.
 * Caller must enforce deployment rate admission before bootstrap/pending creation.
 * Hard storage quotas count expired rows too until `cleanup` removes them.
 */
export declare function d1RetainedStore(db: D1Database, suppliedLimits: RetainedLimits): RetainedStore;
