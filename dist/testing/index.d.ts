/**
 * In-memory stores for tests — this package's own, and any consumer's.
 *
 * Shipped rather than kept in `test/` because every adopter hits the same wall:
 * testing a gated route needs a `GrantStore`, and standing up D1 (or any SQL) to
 * assert "a revoked link 401s" is a lot of ceremony for a unit test. These
 * implement the same contracts the D1 adapter does, including the redemption cap
 * guard, so behaviour matches what production will do.
 *
 * Not for production: no persistence, no concurrency safety.
 */
import type { AccessEvent, AuditSink } from '../core/audit.js';
import type { AccessRequest } from '../core/requests.js';
import type { GrantStore, RequestStore } from '../core/store.js';
import type { Grant } from '../core/types.js';
export interface MemoryGrantStore extends GrantStore {
    /** Live rows, for assertions the interface doesn't expose. */
    rows: Map<string, Grant>;
    /** tokenHash -> grant id. */
    hashes: Map<string, string>;
}
export declare function memoryGrantStore(): MemoryGrantStore;
export interface MemoryRequestStore extends RequestStore {
    rows: Map<string, AccessRequest>;
}
export declare function memoryRequestStore(): MemoryRequestStore;
export interface MemoryAudit extends AuditSink {
    events: AccessEvent[];
}
export declare function memoryAudit(): MemoryAudit;
