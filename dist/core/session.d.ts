export declare const DEFAULT_COOKIE_NAME = "oa_auth";
export declare const DEFAULT_SESSION_TTL_S: number;
export interface SessionClaims {
    v: 1;
    sub: string;
    /**
     * Issued-at, epoch seconds. Added so grant rotation can boot sessions minted
     * before a re-key (`gate.rotate({ endSessions: true })`): a session whose
     * `iat` predates the grant's rotation epoch is rejected. Cookies signed
     * before this field existed decode with `iat` absent; `verifySessionClaims`
     * reports those as `iat: 0` (oldest), so an epoch check conservatively boots
     * an un-datable session — the safe reading for a compromise scenario.
     */
    iat: number;
    exp: number;
}
export declare const emailSub: (email: string) => string;
export declare const grantSub: (id: string) => string;
/** Split a `sub` into its kind and value, or null if it is not a shape we mint. */
export declare function parseSub(sub: string): {
    kind: 'email' | 'grant';
    value: string;
} | null;
export declare function signSession(sub: string, secret: string, nowMs: number, ttlS?: number): Promise<string>;
/**
 * Returns the verified claims (`sub`, `iat`, `exp`), or null if the value is
 * malformed, forged, or expired. `iat` defaults to `0` for cookies minted
 * before the field existed, so an epoch check treats an un-datable session as
 * the oldest possible. Most callers only want `sub` and use `verifySession`.
 */
export declare function verifySessionClaims(value: string, secret: string, nowMs: number): Promise<{
    sub: string;
    iat: number;
    exp: number;
} | null>;
/** Returns the `sub` claim, or null if the value is malformed, forged, or expired. */
export declare function verifySession(value: string, secret: string, nowMs: number): Promise<string | null>;
export interface CookieOpts {
    name?: string;
    ttlS?: number;
    /** Defaults to true; pass the request's protocol so http://localhost still works. */
    secure?: boolean;
    sameSite?: 'Lax' | 'Strict' | 'None';
    path?: string;
}
export declare function sessionCookie(value: string, opts?: CookieOpts): string;
export declare function clearCookie(opts?: CookieOpts): string;
export declare function readCookie(req: Request, name: string): string | null;
/** `Secure` breaks cookies on plain-http dev origins, so derive it from the request. */
export declare const isSecureRequest: (req: Request) => boolean;
