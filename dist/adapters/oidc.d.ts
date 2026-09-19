import type { Gate } from '../core/gate.js';
export interface OidcProvider {
    authUrl: string;
    tokenUrl: string;
    jwksUrl: string;
    /** Accepted `iss` values. Google notoriously issues two spellings. */
    issuer: string | string[];
    scope: string;
}
export declare const GOOGLE: OidcProvider;
export interface OidcOptions {
    gate: Gate;
    clientId: string;
    clientSecret: string;
    /** Must match the provider's registered redirect exactly. */
    redirectUri: string;
    provider?: OidcProvider;
    /** Extra authorization params — `hd` to hint a Google Workspace domain, say. */
    authParams?: Record<string, string>;
    /** How long the sign-in round-trip may take. Default 10 minutes. */
    stateTtlS?: number;
    /** Cookie holding the nonce between the two requests. */
    nonceCookieName?: string;
    fetch?: typeof globalThis.fetch;
}
/**
 * Start the flow: mint a nonce, sign it into the state, and bounce to the
 * provider.
 *
 * The state is signed with the *session* secret but can never be presented as
 * a session: `parseSub` only accepts `e:`/`g:` subjects, and this one is
 * `oidc:`. The reverse holds too — a stolen session cookie is not a valid
 * state — so the two token types are mutually inert.
 */
export declare function oidcStart(opts: OidcOptions): ({ request }: {
    request: Request;
}) => Promise<Response>;
/**
 * Finish the flow: check the state and nonce, trade the code for an id_token,
 * verify it, and mint a session for the address it names.
 *
 * Every failure is a plain 400/401 with no detail, because everything here is
 * attacker-reachable and the differences between "bad state" and "bad nonce"
 * are only useful to whoever is probing.
 */
export declare function oidcCallback(opts: OidcOptions): ({ request }: {
    request: Request;
}) => Promise<Response>;
/**
 * Google One Tap / FedCM — the same identity as the redirect flow, without the
 * two-page bounce. The browser hands us a Google-signed **id_token** in the
 * page (via GSI), the FE POSTs it here, and we verify it exactly as
 * `oidcCallback` does — this is that handler's second half (verify id_token →
 * `signIn`) exposed as a credential-in endpoint instead of a code-in one.
 *
 * The replay defence is the same storage-free trick as the redirect `state`:
 * `googleOneTapNonce` mints an HMAC-signed nonce, the page feeds it to GSI, and
 * the id_token comes back carrying it. Because the nonce is signed with the gate
 * secret, only a nonce *we* issued (and not yet expired) can satisfy a verify —
 * no server-side pending-nonce table required.
 */
export interface OneTapNonceOptions {
    gate: Gate;
    /** How long the minted nonce is valid. Default 300s. */
    ttlS?: number;
}
/**
 * `GET` handler → `{ nonce }`. The page passes `nonce` to
 * `google.accounts.id.initialize({ nonce })` and echoes the same value back to
 * `googleOneTapVerify`. The value is opaque and single-window; it is not a
 * bearer credential (it authorizes nothing without a Google-signed id_token
 * that embeds it).
 */
export declare function googleOneTapNonce(opts: OneTapNonceOptions): (_ctx?: {
    request?: Request;
}) => Promise<Response>;
export interface OneTapVerifyOptions {
    gate: Gate;
    /** The OAuth client id; must equal the id_token `aud`. */
    clientId: string;
    provider?: OidcProvider;
    fetch?: typeof globalThis.fetch;
}
/**
 * `POST {credential, nonce}` handler. `credential` is a Google id_token, `nonce`
 * the value from `googleOneTapNonce`. On success the session is signed into
 * *this* response (`200`) — the page is already where it wants to be, so unlike
 * the redirect flow there is nothing to redirect to. A verified-but-not-allowed
 * identity returns `401 {denied: <email>}` so the FE can pre-fill request-access
 * with the Google-verified address.
 */
export declare function googleOneTapVerify(opts: OneTapVerifyOptions): ({ request }: {
    request: Request;
}) => Promise<Response>;
