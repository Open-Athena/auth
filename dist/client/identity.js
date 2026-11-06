export const DEFAULT_WHOAMI_ENDPOINT = '/api/auth/whoami';
/**
 * Best available human label: the *person*, then an email, or null for an
 * anonymous link. A link's memo is not a candidate: it's the minter's note, and
 * a gate doesn't send it to the link session.
 */
export function displayName(whoami) {
    if (!whoami)
        return null;
    if (whoami.kind === 'grant') {
        const subject = whoami.subject ?? {};
        return subject.name || subject.email || whoami.email || null;
    }
    // A self-set name wins over the bare email: it's who the person said they are.
    return whoami.subject?.name || whoami.email || null;
}
export function hasScope(whoami, scope) {
    if (!whoami)
        return false;
    return whoami.scopes.includes('*') || whoami.scopes.includes(scope);
}
