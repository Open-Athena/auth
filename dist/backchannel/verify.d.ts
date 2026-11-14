import type { LogoutEvidence } from './store.js';
export declare const LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";
export declare const MAX_LOGOUT_TOKEN_BYTES = 8192;
export interface LogoutVerifierOptions {
    issuer: string;
    clientId: string;
    jwksUrl: string;
    fetch?: typeof globalThis.fetch;
    /** Maximum exp - iat (default 120 seconds). */
    maxLifetimeS?: number;
    /** Future iat allowance only; expiry is never extended (default 30 seconds). */
    clockSkewS?: number;
}
export declare function checkVerifierOptions(opts: LogoutVerifierOptions): void;
/** Invalid credentials return null; configuration and dependency faults throw. No mutation. */
export declare function verifyLogoutToken(token: string, opts: LogoutVerifierOptions, nowS?: number): Promise<LogoutEvidence | null>;
export declare class BodyTooLarge extends Error {
}
export declare function boundedText(source: {
    body: ReadableStream<Uint8Array> | null;
}, maxBytes: number): Promise<string>;
