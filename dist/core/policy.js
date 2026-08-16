/**
 * Who an SSO identity is allowed to be, and what they get.
 *
 * This is where specs/overview.md's "allowlist: domain-match or DB table?"
 * question lands: neither is baked in. A policy is just
 * `(email) => scopes | null`, so a domain match, a DB-backed allowlist table
 * (applitrack's `allowed_users` shape), or both composed, all satisfy it.
 * Returning null denies — the IdP authenticated them, we don't authorize them.
 */
import { ALL_SCOPES } from './types.js';
const domainOf = (email) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();
/** Anyone at one of `domains` gets `scopes`. The common default (watchy: `@openathena.ai` -> `internal`). */
export function domainPolicy(domains, scopes) {
    const allowed = new Set(domains.map(d => d.replace(/^@/, '').toLowerCase()));
    return email => (allowed.has(domainOf(email)) ? [...scopes] : null);
}
/** Any authenticated identity gets `scopes` — the IdP is the whole allowlist. */
export function anyEmailPolicy(scopes) {
    return () => [...scopes];
}
/** First policy to return non-null wins; scopes are not merged. */
export function firstMatch(...policies) {
    return async (email) => {
        for (const p of policies) {
            const scopes = await p(email);
            if (scopes)
                return scopes;
        }
        return null;
    };
}
/** Listed admins get `*`, ahead of any other policy. */
export function adminPolicy(adminEmails) {
    const admins = new Set(adminEmails.map(e => e.toLowerCase()));
    return email => (admins.has(email.toLowerCase()) ? [ALL_SCOPES] : null);
}
