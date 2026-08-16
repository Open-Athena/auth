/** A fresh share-link token. Shown to the minter exactly once; only its hash is stored. */
export declare const generateToken: () => string;
/**
 * A fresh grant id. Random rather than autoincrement so ids in URLs and audit
 * rows don't leak how many grants exist or let one be guessed from another.
 */
export declare const generateId: () => string;
export declare function hashToken(token: string): Promise<string>;
/**
 * HMAC a client IP so access-log rows correlate without storing raw addresses.
 * Keyed (not a bare hash) because the IPv4 space is small enough to enumerate.
 */
export declare function hashIp(ip: string, secret: string): Promise<string>;
