/**
 * Cloudflare Access as an SSO IdP — the *only* CF-gated path in the Tier-2
 * shape. Everything else is public at the edge; this endpoint trades an Access
 * identity for a first-party session cookie and bounces back.
 *
 * We verify the RS256 `Cf-Access-Jwt-Assertion` ourselves rather than trusting
 * `Cf-Access-Authenticated-User-Email`, for two reasons: the friendly header is
 * not forwarded through Pages origin-to-origin proxying, and full verification
 * keeps the identity trustworthy even if the edge gating is later
 * misconfigured or removed.
 *
 * Peers of this file: Google/GitHub OIDC, WorkOS, or no IdP at all
 * (share-links-only). None of them touch `core`.
 */
import type { Gate } from '../core/gate.js';
/**
 * Verify an Access JWT against the Zero Trust team's public certs and return
 * the authenticated email, or null. `aud` is checked when `expectedAud` is
 * given — do give it: without it any app in the same team is accepted.
 */
export declare function verifyAccessJwt(jwt: string, teamDomain: string, expectedAud?: string, nowMs?: number): Promise<string | null>;
export interface SsoHandlerOptions {
    gate: Gate;
    /** e.g. `https://<team>.cloudflareaccess.com` — no trailing slash; must match the JWT `iss`. */
    teamDomain: string;
    /** The Access application's AUD tag. Strongly recommended. */
    aud?: string;
}
/**
 * Build the `/auth/sso` handler: verify Access -> mint session -> 302 to `next`.
 * Usable directly as a Pages Function `onRequest`.
 */
export declare function ssoHandler({ gate, teamDomain, aud }: SsoHandlerOptions): ({ request }: {
    request: Request;
}) => Promise<Response>;
export interface SsoSessionHandlerOptions {
    /** HMAC key for the session cookie. Must match the gate that will verify it. */
    secret: string;
    /** e.g. `https://<team>.cloudflareaccess.com` — no trailing slash; must match the JWT `iss`. */
    teamDomain: string;
    /** The Access application's AUD tag. Strongly recommended. */
    aud?: string;
    cookieName?: string;
    sessionTtlS?: number;
}
/**
 * `ssoHandler` without a gate — for a deployment that can mint sessions but
 * can't verify them, because the store lives somewhere else. watchy's Pages
 * project is the case: its `/auth/sso` is the only Access-gated path, but the
 * auth authority (and D1 binding) is a separate Worker, so taking a whole gate
 * costs it a binding it has no other use for.
 *
 * Safe because a session cookie carries no authorization: the claim is only
 * `e:<email>`, and scopes are re-derived from `policy` on every `authenticate`.
 * So this mints for any Access-verified email and the gate decides later —
 * the same order of operations `ssoHandler` uses, minus the early rejection
 * (and minus the `signin` audit row, which needs the gate's sink).
 */
export declare function ssoSessionHandler({ secret, teamDomain, aud, cookieName, sessionTtlS }: SsoSessionHandlerOptions): ({ request }: {
    request: Request;
}) => Promise<Response>;
