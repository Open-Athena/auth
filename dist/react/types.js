export const DEFAULT_WHOAMI_ENDPOINT = '/api/auth/whoami';
/**
 * Best available human label: the *person* first, then the link's memo, then an
 * email.
 *
 * Subject before name, because they answer different questions. `name` is an
 * admin's memo — "Q3 board packet", "test-1756800000" — written for the table
 * it appears in, while `subject` is who the link was minted *for*. Preferring
 * the memo meant a link with both rendered "Private link for Q3 board packet",
 * which is the wrong noun in the wrong sentence.
 */
export function displayName(whoami) {
    if (!whoami)
        return null;
    if (whoami.kind === 'grant') {
        const subject = whoami.subject ?? {};
        return subject.name || whoami.name || subject.email || whoami.email || null;
    }
    // A self-set name wins over the bare email, same as a grant's subject wins
    // over its memo — it's who the person said they are.
    return whoami.subject?.name || whoami.email || null;
}
export function hasScope(whoami, scope) {
    if (!whoami)
        return false;
    return whoami.scopes.includes('*') || whoami.scopes.includes(scope);
}
