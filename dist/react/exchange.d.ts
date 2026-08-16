export interface ExchangeOptions {
    /** Query param carrying the token. Default `key`. */
    param?: string;
    /** Default `/api/auth/exchange`. */
    endpoint?: string;
}
export declare const hasKeyParam: ({ param }?: ExchangeOptions) => boolean;
/**
 * Trade a `?key=<token>` share link for a session cookie.
 *
 * The token is claimed — read *and* stripped from the URL — synchronously,
 * before the network call. Two reasons, both learned the hard way:
 *
 *  - A token left in the URL survives in history, in the back button, and in
 *    whatever the recipient copy-pastes onward. It goes as early as possible,
 *    and it goes whether or not the exchange succeeds.
 *  - Stripping first makes this function self-idempotent. A second concurrent
 *    call (React StrictMode double-invokes effects; so does any remount) finds
 *    no token and does nothing, instead of spending a second redemption.
 *    Redemptions are the forwarding signal — double-counting them makes the
 *    admin view lie about how widely a link travelled.
 */
export declare function exchangeKeyParam(opts?: ExchangeOptions): Promise<boolean>;
/**
 * Run the exchange once on mount if a token is present. Returns whether the
 * identity probe may proceed — false only for the moment the exchange is in
 * flight, so the wall never flashes before a valid link has been redeemed.
 */
export declare function useKeyExchange(opts?: ExchangeOptions | false): boolean;
