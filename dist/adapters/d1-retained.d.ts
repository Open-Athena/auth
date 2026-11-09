import type { RetainedLimits, RetainedStore } from '../core/retained-store.js';
/** The retained-login registry on D1: requires root migrations 0003/0004 plus
 * migrations/retained-login/0001_admission.sql and transactional D1 batch.
 * No read/independent-write completion, compensations or network policy callbacks.
 * Hard storage quotas count expired rows too until `cleanup` removes them.
 * Admission counts successful allocations only; its two rows per trusted gate
 * persist independently of cleanup. All writers must use the same configuration.
 */
export declare function d1RetainedStore(db: D1Database, suppliedLimits: RetainedLimits): RetainedStore;
