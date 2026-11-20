import type { Gate } from '../core/gate.js';
import { type SigningJwk } from './keys.js';
import type { PreviewPrs, PreviewSource } from './preview-source.js';
import type { ProviderStore } from './store.js';
/** One app allowed to sign people in here. */
export interface ProviderClient {
    id: string;
    /** For people: what this app is (the preview consent page names it). */
    name?: string;
    /** `hashClientSecret(secret)`: the secret itself never sits in config. */
    secretHash: string;
    /** Exact matches only: no prefixes, no normalizing, and no wildcards except a preview client's patterns. */
    redirectUris: string[];
    /** Where RP-initiated logout may send the browser afterwards (exact matches, or a preview client's patterns). */
    postLogoutRedirectUris?: string[];
    /**
     * A PR-preview client: its URIs may include `https://*.<host>/<path>`
     * patterns (one DNS label, `redirects.ts`), and since a preview is unreviewed
     * code, it never signs anyone in silently. The first sign-in per preview
     * host, account and client is one click on a page here naming the host,
     * remembered for `previewConsentTtlS` (`prompt=consent` asks again anyway, e.g. an app's
     * `/auth/oa?prompt=consent`); `prompt=none` gets `interaction_required` until
     * then. Give it its own id (so its tokens' `aud` differs from the app's)
     * and its own secret, held only by the preview deployment.
     */
    preview?: boolean;
    /**
     * A preview client's builds: which GitHub repo, and which host label is which PR (`pr-{n}`). With it
     * (and `ProviderOptions.previewPrs`), the consent page shows the PR, looked up here, and a closed or
     * merged PR's preview is refused. Admin-set, never the preview's own say.
     */
    previewSource?: PreviewSource;
    /**
     * How long a preview client's consent click lasts, in seconds: default 7 days, at most 30; 0 asks at every sign-in.
     * Admin-set, like `previewSource`. Lowering it applies to clicks already given.
     */
    previewConsentTtlS?: number;
    /** A per-app admission rule on top of the provider's `policy`. */
    allow?: (email: string) => boolean | Promise<boolean>;
    /**
     * `false` admits requests without PKCE from this client (OIDC Core RPs that
     * rely on `nonce`, e.g. the OpenID conformance suite). A challenge, when sent,
     * is still S256 only and its verifier still required. Default `true`.
     */
    requirePkce?: boolean;
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
    /**
     * Clients beyond the static `clients`, which win on a clash: `clientLookup`
     * over a `ClientRegistry`. Asked on every request, so a client it stops
     * returning is cut off at once.
     */
    lookupClient?: (id: string) => Promise<ProviderClient | null>;
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
    /**
     * `POST <basePath>/slack-emoji` lookups allowed per client per minute (default 30), or `false` to turn the route
     * off. Counted in this isolate's memory: a bound on a runaway client, not an exact quota.
     */
    slackEmojiLookupsPerMinute?: number | false;
    /** Looks up a preview client's PR (`githubPreviewPrs`). Without it, a `previewSource` shows "couldn't check GitHub". */
    previewPrs?: PreviewPrs;
}
/** What a client registry stores in place of a secret. */
export declare const hashClientSecret: (secret: string) => Promise<string>;
/** A person's Slack emoji, under `profile`: `:name:`, or null when they have none (so an app's copy is cleared). */
export declare const SLACK_EMOJI_CLAIM = "oa_slack_emoji";
/** Most emails one `POST <basePath>/slack-emoji` may ask about. */
export declare const MAX_LOOKUP_EMAILS = 100;
/** How long one click on the preview consent page lasts by default, at most, and how many hosts a browser remembers. */
export declare const PREVIEW_CONSENT_TTL_S: number;
export declare const PREVIEW_CONSENT_MAX_TTL_S: number;
/** What's wrong with this `previewConsentTtlS`, or null. */
export declare const previewConsentTtlProblem: (ttl: unknown) => string | null;
/** "for 7 days", "for 12 hours": a consent TTL as the page (and the admin dash) says it. */
export declare function previewConsentLasting(ttlS: number): string;
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
