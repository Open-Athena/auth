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
export function allowlistPolicy(store, opts = {}) {
    return async (email) => {
        const scopes = await store.lookup(email.toLowerCase());
        if (scopes === null)
            return null;
        return opts.scopes ? [...opts.scopes] : scopes;
    };
}
