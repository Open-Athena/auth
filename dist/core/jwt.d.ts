export interface VerifyJwtOptions {
    /** Required `iss` claim. */
    issuer: string | string[];
    /** Required `aud` claim, when the issuer scopes tokens to a client. */
    audience?: string;
    nowMs?: number;
    /** Seconds to cache the JWKS response at the edge. Cloudflare-specific; ignored elsewhere. */
    cacheTtlS?: number;
    fetch?: typeof globalThis.fetch;
}
/**
 * The verified claims, or null. Null covers every failure — malformed, wrong
 * algorithm, unknown key, bad signature, wrong issuer/audience, expired —
 * because a caller can do nothing useful with the distinction, and reporting it
 * back to whoever presented the token is an oracle.
 */
export declare function verifyRs256Jwt<T extends Record<string, unknown>>(jwt: string, jwksUrl: string, { issuer, audience, nowMs, cacheTtlS, fetch }: VerifyJwtOptions): Promise<T | null>;
