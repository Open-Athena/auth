/** Grants (share links / magic links) and the identities they resolve to. */
/** Wildcard scope: granted to admins, matches every `hasScope` check. */
export const ALL_SCOPES = '*';
export function hasScope(auth, scope) {
    return auth.scopes.includes(ALL_SCOPES) || auth.scopes.includes(scope);
}
/** Parse the space-separated `scopes` column. Tolerates commas, since humans type them. */
export const parseScopes = (s) => (s ?? '').split(/[\s,]+/).filter(Boolean);
export const formatScopes = (scopes) => scopes.join(' ');
