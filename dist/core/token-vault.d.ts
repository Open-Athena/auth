export declare function sealToken(token: string, grantId: string, secret: string): Promise<string>;
/** The kept key, or null when it can't be opened (another secret, another grant's copy, a damaged value). */
export declare function openToken(sealed: string, grantId: string, secret: string): Promise<string | null>;
