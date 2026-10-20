import type { PropType, SlotsType, VNodeChild } from 'vue';
import type { Whoami } from '../client/identity.js';
import type { UseWhoamiOptions } from './useWhoami.js';
export interface AuthGateSlotContext {
    whoami: Whoami | null | undefined;
    loading: boolean;
    error: Error | null;
    refetch: () => Promise<void>;
    signOut: () => Promise<void>;
}
export interface AuthGateSlots {
    default?: (context: AuthGateSlotContext & {
        whoami: Whoami;
    }) => VNodeChild;
    unauthenticated?: (context: AuthGateSlotContext) => VNodeChild;
    loading?: (context: AuthGateSlotContext) => VNodeChild;
    error?: (context: AuthGateSlotContext & {
        error: Error;
    }) => VNodeChild;
}
/** Identity presentation only. Authorization remains the server's responsibility. */
export declare const AuthGate: import("vue").DefineComponent<import("vue").ExtractPropTypes<{
    options: {
        type: PropType<UseWhoamiOptions>;
        default: () => {};
    };
}>, () => VNodeChild, {}, {}, {}, import("vue").ComponentOptionsMixin, import("vue").ComponentOptionsMixin, {}, string, import("vue").PublicProps, Readonly<import("vue").ExtractPropTypes<{
    options: {
        type: PropType<UseWhoamiOptions>;
        default: () => {};
    };
}>> & Readonly<{}>, {
    options: UseWhoamiOptions;
}, SlotsType<AuthGateSlots>, {}, {}, string, import("vue").ComponentProvideOptions, true, {}, any>;
