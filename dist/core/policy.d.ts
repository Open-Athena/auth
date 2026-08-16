export type EmailPolicy = (email: string) => string[] | null | Promise<string[] | null>;
/** Anyone at one of `domains` gets `scopes`. The common default (watchy: `@openathena.ai` -> `internal`). */
export declare function domainPolicy(domains: readonly string[], scopes: readonly string[]): EmailPolicy;
/** Any authenticated identity gets `scopes` — the IdP is the whole allowlist. */
export declare function anyEmailPolicy(scopes: readonly string[]): EmailPolicy;
/** First policy to return non-null wins; scopes are not merged. */
export declare function firstMatch(...policies: EmailPolicy[]): EmailPolicy;
/** Listed admins get `*`, ahead of any other policy. */
export declare function adminPolicy(adminEmails: readonly string[]): EmailPolicy;
