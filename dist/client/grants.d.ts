import type { AuthClient } from './api.js';
import type { Grant, GrantActivity, GrantUpdateInput, MintInput, RotateInput } from '../core/http.js';
export type GrantAction = 'update' | 'disable' | 'enable' | 'revoke' | 'rotate';
export interface GrantsFailure {
    action: GrantAction | 'mint' | 'refresh' | 'activity';
    /** Null for `mint` and `refresh`, which aren't about one link. */
    grantId: string | null;
    /** The route's `detail` or `error` when it gave one, for display. */
    message: string;
    error: unknown;
}
export interface OneTimeToken {
    grantId: string;
    token: string;
    source: 'mint' | 'rotate';
}
export interface GrantsSnapshot {
    grants: readonly Grant[];
    /** True once a list has arrived: "no links yet" is only knowable then. */
    loaded: boolean;
    /** A list request is in flight. */
    loading: boolean;
    minting: boolean;
    /** Per-link actions in flight, by grant id. */
    pending: Readonly<Record<string, GrantAction>>;
    error: GrantsFailure | null;
    token: OneTimeToken | null;
    /** The last `activity(id)` result per link. */
    activities: Readonly<Record<string, GrantActivity>>;
}
export interface GrantsControllerOptions {
    client: AuthClient;
    /** Told about a 401, so `useWhoami` can show the wall. Default `<client.basePath>/whoami`. */
    whoamiEndpoint?: string;
}
export declare function createGrantsController({ client, whoamiEndpoint }: GrantsControllerOptions): {
    subscribe(listener: () => void): () => void;
    getSnapshot: () => GrantsSnapshot;
    refresh: () => Promise<void>;
    /** The new link, or null if it failed (see `error`). Its token is in the snapshot, not here. */
    mint: (input: MintInput) => Promise<Grant | null>;
    update: (id: string, patch: GrantUpdateInput) => Promise<boolean>;
    disable: (id: string) => Promise<boolean>;
    enable: (id: string) => Promise<boolean>;
    revoke: (id: string) => Promise<boolean>;
    rotate: (id: string, input?: RotateInput) => Promise<boolean>;
    activity: (id: string) => Promise<void>;
    dismissToken(): void;
};
export type GrantsController = ReturnType<typeof createGrantsController>;
