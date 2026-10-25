import type { SessionLossReason } from '../core/denial.js';
import type { WhoamiSource } from './identity.js';
export interface UnauthenticatedEvent {
    reason: SessionLossReason | null;
    endpoint: string;
}
/** Report a failed request, not a logout command: subscribers revalidate. */
export declare function reportUnauthenticated(reason?: SessionLossReason | null, source?: WhoamiSource): void;
export declare function subscribeUnauthenticated(listener: (event: UnauthenticatedEvent) => void): () => void;
