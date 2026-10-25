import type { Ref } from 'vue';
import type { AuthClient, AuthClientOptions } from '../client/api.js';
import type { ExchangeOptions } from '../client/exchange.js';
import type { Whoami } from '../client/identity.js';
import type { SessionLossReason } from '../core/denial.js';
export interface UseWhoamiOptions extends AuthClientOptions {
    client?: AuthClient;
    staleTime?: number;
    /** Periodic revalidation in seconds. Off by default. */
    revalidateS?: number;
    /** Disabled by default; AuthGate enables exchange before its first probe. */
    exchange?: ExchangeOptions | false;
}
export interface UseWhoamiResult {
    whoami: Readonly<Ref<Whoami | null | undefined>>;
    loading: Readonly<Ref<boolean>>;
    error: Readonly<Ref<Error | null>>;
    reason: Readonly<Ref<SessionLossReason | null>>;
    refetch: () => Promise<void>;
    signOut: () => Promise<void>;
}
export declare function useWhoami(options?: UseWhoamiOptions): UseWhoamiResult;
