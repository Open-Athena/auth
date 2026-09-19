export const DEFAULT_ENDPOINTS = {
    edge: '/cdn-cgi/access/get-identity',
    app: '/api/auth/whoami',
};
/**
 * Best available human label: the *person* first, then the link's memo, then an
 * email.
 *
 * Subject before name, because they answer different questions. `name` is an
 * admin's memo — "Q3 board packet", "test-1756800000" — written for the table
 * it appears in, while `subject` is who the link was minted *for*. Preferring
 * the memo meant a link with both rendered "Private link for Q3 board packet",
 * which is the wrong noun in the wrong sentence.
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
        return full || w.name || subject.email || w.email || null;
    }
    if (w.kind === 'sso') {
        // A self-set name wins over the bare email, same as a grant's subject wins
        // over its memo — it's who the person said they are.
        const subject = w.subject ?? {};
        const full = [subject.first, subject.last].filter(Boolean).join(' ');
        return full || w.email || null;
    }
    return w.name ?? w.email ?? null;
}
export function hasScope(whoami, scope) {
    const scopes = whoami?.scopes;
    if (!Array.isArray(scopes))
        return false;
    return scopes.includes('*') || scopes.includes(scope);
}
