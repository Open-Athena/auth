import type { BackchannelStore } from './store.js';
import { type LogoutVerifierOptions } from './verify.js';
export interface BackchannelReceiverOptions extends LogoutVerifierOptions {
    store: BackchannelStore;
    /** Tombstone lifetime after receipt, including the adopter's callback/skew window. */
    retentionS: number;
    /** Epoch seconds, not milliseconds. */
    now?: () => number;
}
/** Opt-in endpoint handler only: it records revocation, but never clears or authorizes app sessions. */
export declare function backchannelLogoutReceiver(opts: BackchannelReceiverOptions): (req: Request) => Promise<Response>;
