export const DEFAULT_ENDPOINTS = {
    edge: '/cdn-cgi/access/get-identity',
    app: '/api/auth/whoami',
};
/**
 * Best available human label: the grant's name, then its subject, then an email.
 *
 * `EdgeWhoami`'s index signature makes the union un-narrowable by `kind` alone
 * (every member structurally admits a `kind` field), so this reads fields off a
 * single widened view rather than pretending the discriminant works here.
 */
export function displayName(whoami) {
    if (!whoami)
        return null;
    const w = whoami;
    if (w.kind === 'grant') {
        const subject = w.subject ?? {};
        const full = [subject.first, subject.last].filter(Boolean).join(' ');
        return w.name ?? (full || null) ?? subject.email ?? w.email ?? null;
    }
    if (w.kind === 'sso')
        return w.email ?? null;
    return w.name ?? w.email ?? null;
}
export function hasScope(whoami, scope) {
    const scopes = whoami?.scopes;
    if (!Array.isArray(scopes))
        return false;
    return scopes.includes('*') || scopes.includes(scope);
}
