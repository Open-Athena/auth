/**
 * The OIDC provider's D1 stores: `provider_codes` and the client registry, from
 * `migrations/provider/` (a track of its own, applied only on the deployment
 * that issues identity).
 */
import type { ClientRegistry } from '../provider/registry.js';
import type { ProviderStore } from '../provider/store.js';
export interface D1ProviderOptions {
    /** Expired codes one `cleanup` deletes at most (default 500). */
    cleanupChunk?: number;
}
export declare function d1ProviderStore(db: D1Database, { cleanupChunk }?: D1ProviderOptions): ProviderStore;
export declare function d1ClientRegistry(db: D1Database): ClientRegistry;
