/**
 * Sign in with an OIDC provider directly, instead of putting Cloudflare Access
 * in front of the app as an IdP.
 *
 * Requested by marin-gcs-usage (`specs/google-oidc-idp.md`) for two reasons
 * worth recording: Access's hosted chooser is generic and unstylable, and —
 * the harder constraint — every Access-authenticated user consumes a Zero
 * Trust seat, which is a ceiling a growing allowlist eventually hits. Share
 * links never touched Access, which is why they never had that problem.
 *
 * Generic rather than Google-only: an issuer is four URLs, and `GOOGLE` is a
 * preset rather than a special case. Only the authorization-code flow, only
 * confidential clients (server-side, with a secret) — that's what a Worker or
 * Pages Function is.
 *
 * The two things that make this safe are both storage-free:
 *
 * - **state** is HMAC'd with the gate secret and carries the `next` path plus a
 *   nonce, so nothing has to be persisted between the two requests;
 * - **the nonce is double-submitted** — it rides in the signed state *and* in a
 *   short-lived cookie, and both must agree. Without that, a signed state an
 *   attacker minted from their own sign-in would be replayable against someone
 *   else's browser, which is login-CSRF: the victim ends up silently signed in
 *   as the attacker.
 */
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
