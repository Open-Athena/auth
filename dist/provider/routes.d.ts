import type { Gate } from '../core/gate.js';
import { type SigningJwk } from './keys.js';
import type { ProviderStore } from './store.js';
/** One app allowed to sign people in here. */
export interface ProviderClient {
    id: string;
    /** `hashClientSecret(secret)`: the secret itself never sits in config. */
    secretHash: string;
    /** Exact matches only: no prefixes, no wildcards, no normalizing. */
    redirectUris: string[];
    /** Where RP-initiated logout may send the browser afterwards (exact matches). */
    postLogoutRedirectUris?: string[];
    /** A per-app admission rule on top of the provider's `policy`. */
    allow?: (email: string) => boolean | Promise<boolean>;
}
export interface ClaimsInput {
    email: string;
    client: ProviderClient;
    /** The granted scopes. */
    scopes: string[];
}
export interface ProviderOptions {
    /** The broker's gate: its sessions are who is signed in here. */
    gate: Gate;
    /** Exactly what tokens carry as `iss`, e.g. `https://login.oa.dev`. No trailing slash. */
    issuer: string;
    clients: ProviderClient[];
    /** Private RS256 JWKs; the first signs, all are published. */
    keys: SigningJwk[];
    store: ProviderStore;
    /**
     * Keys `sub`: `HMAC(subjectSecret, "e:" + email)`. Stable across clients and
     * deployments, so keep it stable too: changing it changes every `sub`.
     */
    subjectSecret: string;
    /** Where the endpoints live under the issuer's origin (default `/oidc`). */
    basePath?: string;
    /**
     * The broker's sign-in page (same origin). Sent `next` (back to
     * `/authorize`), and `prompt` / `login_hint` when the app gave them. It must
     * return to `next` only once someone is signed in.
     */
    loginUrl: string;
    /** Who may sign in to any app here at all (default: anyone the gate admits). */
    policy?: (input: {
        email: string;
        client: ProviderClient;
    }) => boolean | Promise<boolean>;
    /** Extra ID token and userinfo claims (`groups`, say). Can't override the standard ones. */
    claims?: (input: ClaimsInput) => Record<string, unknown> | Promise<Record<string, unknown>>;
    /** Extra scopes advertised in discovery, for `claims` to act on. */
    scopes?: string[];
    /** ID and access token lifetime (default 300 s). */
    tokenTtlS?: number;
    /** Authorization code lifetime (default 60 s). */
    codeTtlS?: number;
}
/** What a client registry stores in place of a secret. */
export declare const hashClientSecret: (secret: string) => Promise<string>;
export declare function oidcProviderRoutes(opts: ProviderOptions): (req: Request) => Promise<Response | null>;
/** For an app: the broker as an `OidcProvider` (`@open-athena/auth/oidc`), from its issuer. */
export declare function brokerProvider(issuer: string, { basePath, scope }?: {
    basePath?: string | undefined;
    scope?: string | undefined;
}): {
    authUrl: string;
    tokenUrl: string;
    jwksUrl: string;
    issuer: string;
    scope: string;
};
