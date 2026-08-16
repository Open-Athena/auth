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
