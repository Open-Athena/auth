/** A private RSA JWK with its key id (`generateSigningKey`'s output). */
export type SigningJwk = JsonWebKey & {
    kid: string;
};
/** A public JWK as published at the JWKS endpoint. */
export type PublicJwk = {
    kty: 'RSA';
    n: string;
    e: string;
    kid: string;
    alg: 'RS256';
    use: 'sig';
};
/** A fresh 2048-bit RS256 key, as a private JWK. Store it as a secret; never log it. */
export declare function generateSigningKey(kid?: string): Promise<SigningJwk>;
export interface KeySet {
    /** The published half of every key. */
    jwks: {
        keys: PublicJwk[];
    };
    /** Sign a JWT with the current (first) key. */
    sign(payload: Record<string, unknown>, typ?: string): Promise<string>;
    /**
     * The payload of a JWT one of these keys signed, or null. Checks only the
     * signature and `alg`: claims (`iss`, `aud`, `exp`) are the caller's, since
     * a logout's `id_token_hint` is accepted past its `exp` and an access token
     * isn't.
     */
    verify<T extends Record<string, unknown>>(jwt: string): Promise<T | null>;
}
/** Import the keys once; the result signs and verifies. */
export declare function keySet(keys: SigningJwk[]): KeySet;
