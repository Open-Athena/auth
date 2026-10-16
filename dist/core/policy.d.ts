/**
 * Who an SSO identity is allowed to be, and what they get.
 *
 * This is where specs/overview.md's "allowlist: domain-match or DB table?"
 * question lands: neither is baked in. A policy is just
 * `(email) => scopes | null`, so a domain match, a DB-backed allowlist table
 * (applitrack's `allowed_users` shape), or both composed, all satisfy it.
 * Returning null denies — the IdP authenticated them, we don't authorize them.
 */
import type { AllowlistStore } from './store.js';
export type EmailPolicy = (email: string) => string[] | null | Promise<string[] | null>;
/** Anyone at one of `domains` gets `scopes`. The common default (watchy: `@openathena.ai` -> `internal`). */
export declare function domainPolicy(domains: readonly string[], scopes: readonly string[]): EmailPolicy;
/** Any authenticated identity gets `scopes` — the IdP is the whole allowlist. */
export declare function anyEmailPolicy(scopes: readonly string[]): EmailPolicy;
/** First policy to return non-null wins; scopes are not merged. */
export declare function firstMatch(...policies: EmailPolicy[]): EmailPolicy;
/** Listed admins get `*`, ahead of any other policy. */
export declare function adminPolicy(adminEmails: readonly string[]): EmailPolicy;
/**
 * Admit anyone in an `AllowlistStore` — the DB-table allowlist, so membership
 * is edited (or directory-synced) rather than redeployed. Compose it like any
 * other: `firstMatch(adminPolicy(ADMINS), allowlistPolicy(store))`.
 *
 * By default each row carries its own scopes (a board member gets `[VIEW]`, a
 * one-off guest something narrower). Pass `{ scopes }` to ignore the stored
 * scopes and grant a fixed set to every listed identity — the "membership is
 * the whole decision" case, where the table is just a set of addresses.
 */
export declare function allowlistPolicy(store: Pick<AllowlistStore, 'lookup'>, opts?: {
    scopes?: readonly string[];
}): EmailPolicy;
